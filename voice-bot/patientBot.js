// PatientBot - Standalone AI Conversation Logic for Voice Calls
// Extracted from EchoBot to work independently of Bot Framework

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Import the scheduling plugin and CosmosDB service
const { SchedulingPlugin } = require('./schedulingPlugin');

/**
 * PatientBot - A reusable class for intelligent patient conversations
 * 
 * This class extracts the core AI conversation logic from the Bot Framework-dependent
 * EchoBot class, making it suitable for use in ACS voice calls or other contexts.
 * 
 * Features:
 * - Multi-agent conversation routing (triage, adherence, scheduling)
 * - Azure OpenAI integration with retry logic and error handling
 * - Speech-optimized response formatting with SSML
 * - Conversation state management and history tracking
 * - Integration with scheduling and database services
 */
class PatientBot {
    constructor(patientRecord, cosmosDbService = null, azureOpenAIConfig = null) {
        // Patient information
        this.patientRecord = patientRecord;
        this.cosmosDbService = cosmosDbService;
        
        // Conversation state management
        this.conversationHistory = [];
        this.activeAgent = 'triage'; // Start with triage agent
        this.conversationState = {
            triageCompleted: false,
            adherenceCompleted: false,
            schedulingCompleted: false,
            currentMedication: null,
            pendingAppointment: null,
            callCompleted: false
        };
        
        // Azure OpenAI configuration with secure defaults
        this.azureOpenAIConfig = azureOpenAIConfig || {
            endpoint: process.env.AZURE_OPENAI_ENDPOINT,
            apiKey: process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_OPENAI_KEY, // Support both naming conventions
            deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4o',
            apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview',
            maxRetries: 3,
            timeoutMs: 30000,
            retryDelayMs: 1000
        };
        
        // Initialize scheduling plugin
        this.schedulingPlugin = new SchedulingPlugin();
        
        // Validate configuration
        this.validateConfiguration();
        
        console.log(`[PatientBot] Initialized for patient: ${this.patientRecord.patientName}`);
    }
    
    /**
     * Validates the PatientBot configuration
     * Ensures all required environment variables and dependencies are available
     */
    validateConfiguration() {
        const requiredEnvVars = [
            'AZURE_OPENAI_ENDPOINT',
            'AZURE_OPENAI_DEPLOYMENT_NAME'
        ];
        
        // Check for API key (support both naming conventions)
        const hasApiKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_OPENAI_KEY;
        if (!hasApiKey) {
            requiredEnvVars.push('AZURE_OPENAI_API_KEY or AZURE_OPENAI_KEY');
        }
        
        const missingVars = requiredEnvVars.filter(varName => {
            if (varName.includes('or')) return false; // Skip the combined check
            return !process.env[varName];
        });
        
        if (missingVars.length > 0 || !hasApiKey) {
            throw new Error(`Missing required environment variables: ${[...missingVars, ...(hasApiKey ? [] : ['AZURE_OPENAI_API_KEY or AZURE_OPENAI_KEY'])].join(', ')}`);
        }
        
        if (!this.patientRecord || !this.patientRecord.patientName) {
            throw new Error('Valid patient record with patientName is required');
        }
    }
    
    /**
     * Main entry point for processing patient messages
     * Routes conversation through appropriate AI agents based on current state
     */
    async processMessage(userInput) {
        try {
            console.log(`[PatientBot] Processing message for ${this.patientRecord.patientName}: "${userInput}"`);
            
            // Add user message to conversation history
            this.conversationHistory.push({ role: 'user', content: userInput });
            
            let response;
            
            // Emergency safety check first
            if (this.isEmergencyMessage(userInput)) {
                response = this.getEmergencyResponse();
                this.conversationHistory.push({ role: 'assistant', content: response });
                return this.formatSpeechResponse(response, 'emergency');
            }
            
            // Route to appropriate agent based on conversation state
            if (!this.conversationState.triageCompleted) {
                response = await this.callTriageAgent(userInput);
            } else if (!this.conversationState.adherenceCompleted) {
                response = await this.callAdherenceAgent(userInput);
            } else if (!this.conversationState.schedulingCompleted) {
                response = await this.handleSchedulingWithTools(userInput);
            } else {
                // Conversation completed - provide summary or handle additional questions
                response = await this.handlePostConversationMessage(userInput);
            }
            
            // Add assistant response to history
            this.conversationHistory.push({ role: 'assistant', content: response });
            
            // Determine speech context and format response
            const speechContext = this.getSpeechContextFromResponse(response);
            return this.formatSpeechResponse(response, speechContext);
            
        } catch (error) {
            console.error('[PatientBot] Error processing message:', error.message);
            const errorResponse = "I apologize, I'm experiencing some technical difficulties. Let me try again.";
            return this.formatSpeechResponse(errorResponse, 'normal');
        }
    }
    
    /**
     * Emergency safety check for critical health situations
     */
    isEmergencyMessage(message) {
        const emergencyKeywords = [
            'emergency', 'ambulance', 'urgent', 'help', 'pain', 'chest pain',
            'can\'t breathe', 'difficulty breathing', 'bleeding', 'unconscious',
            'seizure', 'heart attack', 'stroke', 'overdose', 'allergic reaction'
        ];
        
        const lowerMessage = message.toLowerCase();
        return emergencyKeywords.some(keyword => lowerMessage.includes(keyword));
    }
    
    /**
     * Emergency safety response
     */
    getEmergencyResponse() {
        return `I understand this may be urgent. For any medical emergency, please hang up and dial 911 immediately. 
                If this is not an emergency, I'm here to help you with your medication questions and appointment scheduling. 
                Would you like to continue with our conversation?`;
    }
    
    /**
     * Triage Agent - Initial assessment and conversation routing
     */
    async callTriageAgent(userInput) {
        const triagePrompt = this.getTriageAgentPrompt();
        
        try {
            const response = await this.callOpenAI(triagePrompt, this.conversationHistory, false);
            
            // Check if triage is complete based on response content
            if (this.isTriageComplete(response.content)) {
                this.conversationState.triageCompleted = true;
                this.activeAgent = 'adherence';
                console.log('[PatientBot] Triage completed, moving to adherence agent');
            }
            
            return response.content;
        } catch (error) {
            console.error('[PatientBot] Triage agent error:', error.message);
            throw error;
        }
    }
    
    /**
     * Adherence Agent - Medication compliance and education
     */
    async callAdherenceAgent(userInput) {
        const adherencePrompt = this.getAdherenceAgentPrompt();
        
        try {
            const response = await this.callOpenAI(adherencePrompt, this.conversationHistory, false);
            
            // Extract adherence data and check completion
            const adherenceData = this.extractAdherenceData(response.content);
            
            if (this.isAdherenceComplete(response.content)) {
                this.conversationState.adherenceCompleted = true;
                this.activeAgent = 'scheduling';
                
                // Save adherence data
                await this.savePatientCallData(adherenceData, null);
                console.log('[PatientBot] Adherence completed, moving to scheduling agent');
            }
            
            return response.content;
        } catch (error) {
            console.error('[PatientBot] Adherence agent error:', error.message);
            throw error;
        }
    }
    
    /**
     * Scheduling Agent with Tools - Appointment management
     */
    async handleSchedulingWithTools(userInput) {
        const schedulingPrompt = this.getSchedulingAgentPrompt();
        
        try {
            const aiResponse = await this.callOpenAI(schedulingPrompt, this.conversationHistory, true);
            
            // Handle tool calls if present
            if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
                const toolCall = aiResponse.tool_calls[0];
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments || '{}');
                
                console.log(`[PatientBot] Executing tool: ${functionName} with args:`, functionArgs);
                
                let toolResult;
                try {
                    // Execute the appropriate scheduling function
                    switch (functionName) {
                        case 'findAvailability':
                            toolResult = await this.schedulingPlugin.findAvailability(functionArgs.date);
                            break;
                        case 'createAppointment':
                            toolResult = await this.schedulingPlugin.createAppointment(
                                functionArgs.appointmentDateTime,
                                functionArgs.patientName
                            );
                            break;
                        case 'listAppointments':
                            toolResult = await this.schedulingPlugin.listAppointments(functionArgs.date);
                            break;
                        case 'cancelAppointment':
                            toolResult = await this.schedulingPlugin.cancelAppointment(
                                functionArgs.date,
                                functionArgs.time
                            );
                            break;
                        case 'rescheduleAppointment':
                            toolResult = await this.schedulingPlugin.rescheduleAppointment(
                                functionArgs.originalDate,
                                functionArgs.originalTime,
                                functionArgs.newDateTime,
                                functionArgs.patientName
                            );
                            break;
                        default:
                            throw new Error(`Unknown function: ${functionName}`);
                    }
                    
                    console.log(`[PatientBot] Tool ${functionName} executed successfully`);
                } catch (toolError) {
                    console.error(`[PatientBot] Tool execution error (${functionName}):`, toolError.message);
                    toolResult = `Error: ${toolError.message}`;
                }
                
                // Add tool interaction to conversation history
                this.conversationHistory.push({ 
                    role: 'assistant', 
                    content: null, 
                    tool_calls: aiResponse.tool_calls 
                });
                this.conversationHistory.push({ 
                    role: 'tool', 
                    tool_call_id: toolCall.id, 
                    name: functionName, 
                    content: toolResult 
                });
                
                // Get final natural language response
                const finalResponse = await this.callOpenAI(schedulingPrompt, this.conversationHistory, true);
                
                // Check if scheduling is complete
                if (this.isSchedulingComplete(finalResponse.content)) {
                    this.conversationState.schedulingCompleted = true;
                    this.conversationState.callCompleted = true;
                    
                    // Save appointment data
                    const appointmentData = this.extractAppointmentData(toolResult);
                    await this.savePatientCallData(null, appointmentData);
                    console.log('[PatientBot] Scheduling completed, call finished');
                }
                
                return finalResponse.content || "I've processed your request. Is there anything else I can help you with?";
                
            } else {
                // No tool calls, regular response
                if (this.isSchedulingComplete(aiResponse.content)) {
                    this.conversationState.schedulingCompleted = true;
                    this.conversationState.callCompleted = true;
                    console.log('[PatientBot] Scheduling completed without tools, call finished');
                }
                
                return aiResponse.content;
            }
            
        } catch (error) {
            console.error('[PatientBot] Scheduling error:', error.message);
            return "I apologize, I'm having trouble accessing the appointment calendar right now. Can we try again in a few moments?";
        }
    }
    
    /**
     * Handle messages after main conversation flow is complete
     */
    async handlePostConversationMessage(userInput) {
        const prompt = `You are Jenny, a helpful healthcare assistant. The main conversation flow (triage, adherence, scheduling) has been completed for patient ${this.patientRecord.patientName}. 
                       Respond to any additional questions or provide a polite closing if the patient seems ready to end the call.
                       Keep responses brief and professional.`;
        
        try {
            const response = await this.callOpenAI(prompt, this.conversationHistory.slice(-4), false);
            return response.content;
        } catch (error) {
            console.error('[PatientBot] Post-conversation error:', error.message);
            return "Thank you for speaking with me today. Have a great day and take care!";
        }
    }
    
    /**
     * Core Azure OpenAI API integration with retry logic and error handling
     */
    async callOpenAI(systemPrompt, history, includeTools = true) {
        const messages = [{ role: 'system', content: systemPrompt }, ...history];
        
        // Define scheduling tools for appointment management
        const tools = includeTools ? [
            {
                type: 'function',
                function: {
                    name: 'findAvailability',
                    description: 'Checks for available appointment slots on a specific date (YYYY-MM-DD).',
                    parameters: {
                        type: 'object',
                        properties: {
                            date: { type: 'string', description: 'The date to check, in YYYY-MM-DD format.' }
                        },
                        required: ['date']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'createAppointment',
                    description: 'Books a new appointment.',
                    parameters: {
                        type: 'object',
                        properties: {
                            appointmentDateTime: { 
                                type: 'string', 
                                description: 'The appointment time in ISO 8601 format (e.g., "2025-07-15T14:00:00").' 
                            },
                            patientName: { type: 'string', description: "The patient's name." }
                        },
                        required: ['appointmentDateTime', 'patientName']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'listAppointments',
                    description: 'Lists all appointments for a specific date (YYYY-MM-DD).',
                    parameters: {
                        type: 'object',
                        properties: {
                            date: { type: 'string', description: 'The date to check, in YYYY-MM-DD format.' }
                        },
                        required: ['date']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'cancelAppointment',
                    description: 'Cancels an existing appointment.',
                    parameters: {
                        type: 'object',
                        properties: {
                            date: { type: 'string', description: 'The appointment date in YYYY-MM-DD format.' },
                            time: { type: 'string', description: 'The appointment time (e.g., "9:00 AM").' }
                        },
                        required: ['date', 'time']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'rescheduleAppointment',
                    description: 'Reschedules an appointment.',
                    parameters: {
                        type: 'object',
                        properties: {
                            originalDate: { type: 'string', description: 'The original appointment date (YYYY-MM-DD).' },
                            originalTime: { type: 'string', description: 'The original appointment time.' },
                            newDateTime: { 
                                type: 'string', 
                                description: 'The new appointment time in ISO 8601 format.' 
                            },
                            patientName: { type: 'string', description: "The patient's name." }
                        },
                        required: ['originalDate', 'originalTime', 'newDateTime', 'patientName']
                    }
                }
            }
        ] : [];
        
        // Build request body with secure defaults
        const requestBody = {
            messages,
            max_tokens: 800,
            temperature: 0.6,
            top_p: 0.95,
            frequency_penalty: 0,
            presence_penalty: 0
        };
        
        if (includeTools && tools.length > 0) {
            requestBody.tools = tools;
            requestBody.tool_choice = 'auto';
        }
        
        // Implement retry logic with exponential backoff
        let lastError;
        for (let attempt = 0; attempt < this.azureOpenAIConfig.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.azureOpenAIConfig.timeoutMs);
                
                const response = await axios.post(
                    `${this.azureOpenAIConfig.endpoint}openai/deployments/${this.azureOpenAIConfig.deploymentName}/chat/completions?api-version=${this.azureOpenAIConfig.apiVersion}`,
                    requestBody,
                    {
                        headers: { 
                            'api-key': this.azureOpenAIConfig.apiKey, 
                            'Content-Type': 'application/json' 
                        },
                        signal: controller.signal
                    }
                );
                clearTimeout(timeoutId);
                
                if (!response.data?.choices?.[0]?.message) {
                    throw new Error('Invalid response structure from Azure OpenAI');
                }
                
                console.log(`[PatientBot] Azure OpenAI call successful (attempt ${attempt + 1})`);
                return response.data.choices[0].message;
                
            } catch (error) {
                lastError = error;
                console.error(`[PatientBot] Azure OpenAI API error (attempt ${attempt + 1}):`, error.message);
                
                if (this.isRetryableError(error)) {
                    if (attempt < this.azureOpenAIConfig.maxRetries - 1) {
                        const delay = this.azureOpenAIConfig.retryDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
                        console.log(`[PatientBot] Retrying in ${delay.toFixed(0)}ms...`);
                        await this.sleep(delay);
                        continue;
                    }
                }
                break;
            }
        }
        
        console.error('[PatientBot] Azure OpenAI API failed after all retries.');
        if (lastError.response?.status === 429) throw new Error('rate limit');
        if (lastError.response?.status === 401) throw new Error('authentication');
        if (lastError.name === 'AbortError') throw new Error('timeout');
        throw new Error('API error');
    }
    
    /**
     * Determines if an error is retryable (network issues, rate limits, server errors)
     */
    isRetryableError(error) {
        if (error.name === 'AbortError' || ['ECONNRESET', 'ETIMEDOUT'].includes(error.code)) {
            return true;
        }
        if (error.response) {
            const status = error.response.status;
            return status >= 500 || status === 429;
        }
        return false;
    }
    
    /**
     * Utility function for implementing delays in retry logic
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Agent prompt generators with patient-specific context
     */
    getTriageAgentPrompt() {
        return `You are Jenny, a compassionate healthcare assistant conducting a follow-up call for ${this.patientRecord.patientName}.

PATIENT CONTEXT:
- Name: ${this.patientRecord.patientName}
- Age: ${this.patientRecord.age}
- Primary Medication: ${this.patientRecord.primaryMedication}
- Last Visit: ${this.patientRecord.lastVisit}
- Condition: ${this.patientRecord.condition}

Your role is to warmly greet the patient, confirm their identity, and transition into medication adherence discussion.

INSTRUCTIONS:
1. Greet the patient by name and introduce yourself as Jenny from their healthcare team
2. Confirm you're speaking with the correct person
3. Briefly explain the purpose of the call (follow-up on medication and schedule)
4. Ask how they're feeling today
5. Transition to asking about their medication

Keep responses warm, professional, and conversational. Once you've covered the greeting and confirmed identity, end with asking about their medication to transition to the adherence agent.

EMERGENCY PROTOCOL: If patient mentions emergency symptoms, immediately tell them to hang up and dial 911.`;
    }
    
    getAdherenceAgentPrompt() {
        return `You are Jenny, a healthcare assistant helping ${this.patientRecord.patientName} with medication adherence.

PATIENT MEDICATION INFO:
- Primary Medication: ${this.patientRecord.primaryMedication}
- Dosage: ${this.patientRecord.dosage || 'As prescribed'}
- Frequency: ${this.patientRecord.frequency || 'As prescribed'}

CONVERSATION GOALS:
1. Ask about medication adherence in the past week
2. Inquire about any side effects or concerns
3. Provide education and encouragement
4. Address any barriers to adherence
5. Confirm understanding of proper dosing

Ask specific questions about:
- How many days they took their medication in the past week
- Any missed doses and reasons why
- Any side effects experienced
- Any questions about their medication

Be empathetic and non-judgmental. Once you've thoroughly discussed adherence and the patient seems satisfied, transition to scheduling by mentioning their upcoming appointment needs.

Keep responses concise and focused on medication topics.`;
    }
    
    getSchedulingAgentPrompt() {
        return `You are Jenny, a healthcare assistant helping ${this.patientRecord.patientName} with appointment scheduling.

PATIENT INFO:
- Name: ${this.patientRecord.patientName}
- Last Visit: ${this.patientRecord.lastVisit}
- Follow-up needed: ${this.patientRecord.followUpAppointment?.appointmentType || 'General follow-up'}

AVAILABLE TOOLS: You have access to calendar functions to check availability, book, reschedule, or cancel appointments.

SCHEDULING GOALS:
1. Determine if patient needs to schedule a follow-up appointment
2. Check their availability preferences
3. Use tools to find available slots
4. Book the appointment if patient agrees
5. Confirm appointment details

Be helpful and efficient. Ask about their scheduling preferences and use the available tools to assist them. Always confirm appointment details before finalizing.

Current date context: ${new Date().toDateString()}`;
    }
    
    /**
     * Conversation state checkers
     */
    isTriageComplete(response) {
        const completionIndicators = [
            'medication', 'adherence', 'how have you been taking',
            'let\'s talk about', 'moving on', 'now about'
        ];
        return completionIndicators.some(indicator => 
            response.toLowerCase().includes(indicator.toLowerCase())
        );
    }
    
    isAdherenceComplete(response) {
        const completionIndicators = [
            'appointment', 'schedule', 'follow-up', 'visit',
            'calendar', 'book', 'next step'
        ];
        return completionIndicators.some(indicator => 
            response.toLowerCase().includes(indicator.toLowerCase())
        );
    }
    
    isSchedulingComplete(response) {
        const completionIndicators = [
            'appointment is scheduled', 'booked', 'confirmed',
            'see you then', 'thank you', 'take care',
            'appointment has been', 'scheduled for'
        ];
        return completionIndicators.some(indicator => 
            response.toLowerCase().includes(indicator.toLowerCase())
        );
    }
    
    /**
     * Data extraction methods for saving to database
     */
    extractAdherenceData(response) {
        // Extract adherence information from conversation
        // This would be enhanced based on specific data requirements
        return {
            adherenceScore: this.calculateAdherenceScore(),
            sideEffects: this.extractSideEffects(response),
            concerns: this.extractConcerns(response),
            lastUpdated: new Date().toISOString()
        };
    }
    
    extractAppointmentData(toolResult) {
        // Extract appointment information from tool results
        try {
            if (typeof toolResult === 'string' && toolResult.includes('appointment')) {
                return {
                    appointmentCreated: true,
                    createdDate: new Date().toISOString(),
                    details: toolResult
                };
            }
        } catch (error) {
            console.error('[PatientBot] Error extracting appointment data:', error.message);
        }
        return null;
    }
    
    calculateAdherenceScore() {
        // Simple adherence scoring based on conversation history
        // This would be enhanced with more sophisticated analysis
        const adherenceKeywords = ['every day', 'as prescribed', 'no missed doses'];
        const concernKeywords = ['forgot', 'missed', 'side effects'];
        
        const conversationText = this.conversationHistory
            .filter(msg => msg.role === 'user')
            .map(msg => msg.content)
            .join(' ')
            .toLowerCase();
        
        const positiveCount = adherenceKeywords.filter(keyword => 
            conversationText.includes(keyword)
        ).length;
        
        const negativeCount = concernKeywords.filter(keyword => 
            conversationText.includes(keyword)
        ).length;
        
        return Math.max(0, Math.min(10, 7 + positiveCount - negativeCount));
    }
    
    extractSideEffects(response) {
        const sideEffectKeywords = ['nausea', 'dizzy', 'tired', 'headache', 'side effect'];
        return sideEffectKeywords.filter(keyword => 
            response.toLowerCase().includes(keyword)
        );
    }
    
    extractConcerns(response) {
        const concernKeywords = ['worry', 'concern', 'problem', 'issue'];
        return concernKeywords.filter(keyword => 
            response.toLowerCase().includes(keyword)
        );
    }
    
    /**
     * Speech context determination for SSML formatting
     */
    getSpeechContextFromResponse(response) {
        // Emergency context for safety responses
        if (response.includes('dial 911') || response.includes('emergency services')) {
            return 'emergency';
        }
        
        // Context based on current active agent
        if (this.activeAgent === 'adherence') {
            return 'adherence';
        } else if (this.activeAgent === 'scheduling') {
            return 'scheduling';
        }
        
        // Content-based context detection
        if (response.includes('medication') || response.includes('prescription') ||
            response.includes('dosage') || response.includes('side effects')) {
            return 'adherence';
        }
        
        if (response.includes('appointment') || response.includes('schedule') ||
            response.includes('AM') || response.includes('PM')) {
            return 'scheduling';
        }
        
        return 'normal';
    }
    
    /**
     * Enhanced SSML formatting for optimal voice synthesis
     * Provides context-specific speech formatting for Jenny's voice
     */
    formatSpeechResponse(text, context = 'normal') {
        const ssmlTemplates = {
            welcome: `<speak version="1.0" xml:lang="en-US">
                <voice name="en-US-JennyNeural" style="customerservice" styledegree="0.8">
                    <prosody rate="0.9" pitch="medium">
                        ${text}
                    </prosody>
                </voice>
            </speak>`,
            
            adherence: `<speak version="1.0" xml:lang="en-US">
                <voice name="en-US-JennyNeural" style="empathetic">
                    <prosody rate="0.85" pitch="medium">
                        ${text.replace(/(\d+)\s*(mg|milligrams?|mcg|micrograms?)/gi,
                            '<emphasis level="moderate">$1 $2</emphasis>')
                            .replace(/(once|twice|three times|four times)\s+(daily|a day|per day)/gi,
                            '<emphasis level="moderate">$1 $2</emphasis>')
                            .replace(/(levothyroxine|metformin|amoxicillin|lisinopril|ibuprofen)/gi,
                            '<emphasis level="moderate">$1</emphasis>')}
                    </prosody>
                </voice>
            </speak>`,
            
            scheduling: `<speak version="1.0" xml:lang="en-US">
                <voice name="en-US-JennyNeural" style="customerservice">
                    <prosody rate="0.9">
                        ${text.replace(/(\d{1,2}:\d{2}\s*(AM|PM))/gi,
                            '<emphasis level="strong">$1</emphasis>')}
                    </prosody>
                </voice>
            </speak>`,
            
            emergency: `<speak version="1.0" xml:lang="en-US">
                <voice name="en-US-JennyNeural" style="urgent">
                    <prosody rate="1.0" pitch="high">
                        <emphasis level="strong">${text}</emphasis>
                    </prosody>
                </voice>
            </speak>`,
            
            normal: `<speak version="1.0" xml:lang="en-US">
                <voice name="en-US-JennyNeural" style="customerservice">
                    <prosody rate="0.9" pitch="medium">
                        ${text}
                    </prosody>
                </voice>
            </speak>`
        };
        
        return ssmlTemplates[context] || ssmlTemplates.normal;
    }
    
    /**
     * Save patient call data to Cosmos DB with fallback to local file
     * Implements secure data persistence with proper error handling
     */
    async savePatientCallData(adherenceData = null, appointmentData = null) {
        try {
            if (this.cosmosDbService) {
                console.log(`[PatientBot] Saving patient data to Cosmos DB for ${this.patientRecord.patientName}`);
                
                // Update follow-up call as initiated
                await this.cosmosDbService.updateFollowUpCall(
                    this.patientRecord.DocumentID,
                    {
                        callInitiated: true,
                        callTimestamp: new Date().toISOString()
                    }
                );
                
                // Update adherence answers if provided
                if (adherenceData) {
                    await this.cosmosDbService.updateAdherenceAnswers(
                        this.patientRecord.DocumentID,
                        adherenceData
                    );
                    console.log('[PatientBot] Updated adherence answers in Cosmos DB');
                }
                
                // Schedule appointment if data provided
                if (appointmentData) {
                    await this.cosmosDbService.scheduleFollowUpAppointment(
                        this.patientRecord.DocumentID,
                        appointmentData
                    );
                    console.log('[PatientBot] Updated appointment data in Cosmos DB');
                }
                
                // Mark call as completed if both adherence and appointment are done
                if (adherenceData && appointmentData) {
                    await this.cosmosDbService.markFollowUpCallCompleted(
                        this.patientRecord.DocumentID,
                        null // transcript URL can be added later
                    );
                    console.log('[PatientBot] Marked follow-up call as completed in Cosmos DB');
                }
                
                console.log(`[PatientBot] Successfully updated patient data in Cosmos DB for ${this.patientRecord.patientName}`);
            } else {
                console.warn('[PatientBot] No Cosmos DB service available, falling back to local file');
                this.savePatientCallDataToFile(adherenceData, appointmentData);
            }
        } catch (error) {
            console.error('[PatientBot] Error saving patient call data to Cosmos DB:', error.message);
            
            // Fallback to local file update
            this.savePatientCallDataToFile(adherenceData, appointmentData);
        }
    }
    
    /**
     * Fallback method to save to local file (for development/backup)
     */
    savePatientCallDataToFile(adherenceData = null, appointmentData = null) {
        try {
            const patientsFilePath = path.join(__dirname, 'patients.json');
            const patientsData = JSON.parse(fs.readFileSync(patientsFilePath, 'utf-8'));
            
            // Find the current patient record
            const patientIndex = patientsData.findIndex(p => p.DocumentID === this.patientRecord.DocumentID);
            
            if (patientIndex !== -1) {
                // Update call information
                patientsData[patientIndex].followUpCall.callInitiated = true;
                patientsData[patientIndex].followUpCall.callTimestamp = new Date().toISOString();
                
                if (adherenceData) {
                    patientsData[patientIndex].followUpCall.adherenceAnswers = {
                        ...patientsData[patientIndex].followUpCall.adherenceAnswers,
                        ...adherenceData
                    };
                }
                
                if (appointmentData) {
                    patientsData[patientIndex].followUpAppointment = {
                        ...patientsData[patientIndex].followUpAppointment,
                        ...appointmentData
                    };
                }
                
                // Mark call as completed if both adherence and appointment are done
                if (adherenceData && appointmentData) {
                    patientsData[patientIndex].followUpCall.callCompleted = true;
                }
                
                // Save back to file
                fs.writeFileSync(patientsFilePath, JSON.stringify(patientsData, null, 2));
                console.log(`[PatientBot] Updated local patient data file for ${this.patientRecord.patientName}`);
            }
        } catch (error) {
            console.error('[PatientBot] Error saving patient data to local file:', error.message);
        }
    }
    
    /**
     * Get current conversation state for external monitoring
     */
    getConversationState() {
        return {
            ...this.conversationState,
            activeAgent: this.activeAgent,
            messageCount: this.conversationHistory.length,
            patientName: this.patientRecord.patientName
        };
    }
    
    /**
     * Reset conversation state (useful for testing or restarting conversations)
     */
    resetConversation() {
        this.conversationHistory = [];
        this.activeAgent = 'triage';
        this.conversationState = {
            triageCompleted: false,
            adherenceCompleted: false,
            schedulingCompleted: false,
            currentMedication: null,
            pendingAppointment: null,
            callCompleted: false
        };
        console.log(`[PatientBot] Conversation reset for ${this.patientRecord.patientName}`);
    }
}

module.exports = { PatientBot };
