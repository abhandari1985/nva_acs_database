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
            medicationPickedUp: false,
            dosageDiscussed: false,
            adherenceCompleted: false,
            schedulingStarted: false,
            schedulingCompleted: false,
            triageCompleted: false,
            currentMedication: null,
            pendingAppointment: null,
            callCompleted: false
        };
        
        // Azure OpenAI configuration with secure defaults
        this.azureOpenAIConfig = azureOpenAIConfig || {
            endpoint: process.env.AZURE_OPENAI_ENDPOINT,
            apiKey: process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY, // Support both naming conventions
            deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4o',
            apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview',
            maxRetries: 3,
            timeoutMs: 30000,
            retryDelayMs: 1000
        };
        
        // Initialize scheduling plugin
        this.schedulingPlugin = new SchedulingPlugin(this.patientRecord.patientName);
        
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
        const hasApiKey = process.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_API_KEY;
        if (!hasApiKey) {
            requiredEnvVars.push('AZURE_OPENAI_KEY or AZURE_OPENAI_API_KEY');
        }
        
        const missingVars = requiredEnvVars.filter(varName => {
            if (varName.includes('or')) return false; // Skip the combined check
            return !process.env[varName];
        });
        
        if (missingVars.length > 0 || !hasApiKey) {
            throw new Error(`Missing required environment variables: ${[...missingVars, ...(hasApiKey ? [] : ['AZURE_OPENAI_KEY or AZURE_OPENAI_API_KEY'])].join(', ')}`);
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
            
            // Handle special start call trigger
            if (userInput === '__START_CALL__' || userInput.toLowerCase() === 'hello') {
                const welcomeMessage = `Hello ${this.patientRecord.patientName}! This is Jenny calling for Dr. ${this.patientRecord.doctorName} with your follow-up. Hope you're well! Have you picked up your medication yet for ${this.patientRecord.prescriptions?.[0]?.medicationName || this.patientRecord.primaryMedication}?`;
                this.conversationHistory.push({ role: 'assistant', content: welcomeMessage });
                return this.formatSpeechResponse(welcomeMessage, 'welcome');
            }
            
            // Add user message to conversation history
            this.conversationHistory.push({ role: 'user', content: userInput });
            
            // Emergency safety check first
            if (this.isEmergencyMessage(userInput)) {
                const response = this.getEmergencyResponse();
                this.conversationHistory.push({ role: 'assistant', content: response });
                return this.formatSpeechResponse(response, 'emergency');
            }
            
            // Update conversation state based on user response
            this.updateConversationState(userInput);
            
            // Route to appropriate agent based on conversation state
            const route = await this.callTriageAgent(userInput);
            console.log(`[PatientBot] Triage decision: ${route}`);
            
            let response;
            
            // Handle safety override with scheduling continuation
            if (route.includes('ROUTE_TO_SAFETY')) {
                response = this.getEmergencyResponse() + " Would you like to schedule your follow-up with Dr. " + this.patientRecord.doctorName + "?";
                this.conversationHistory.push({ role: 'assistant', content: response });
                this.conversationState.adherenceCompleted = true; // Mark adherence as completed
                return this.formatSpeechResponse(response, 'emergency');
            }
            
            // Route to appropriate agent based on conversation state and triage
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
            "can't breathe", 'difficulty breathing', 'bleeding', 'unconscious',
            'seizure', 'heart attack', 'stroke', 'overdose', 'allergic reaction',
            'breathless', 'dizzy'
        ];
        
        const lowerMessage = message.toLowerCase();
        return emergencyKeywords.some(keyword => lowerMessage.includes(keyword));
    }
    
    /**
     * Emergency safety response
     */
    getEmergencyResponse() {
        return "Thanks for letting me know. That could be important. If you're experiencing anything like chest pain, trouble breathing, or feeling very unwell, please call your doctor or 911 right away.";
    }
    
    /**
     * Update conversation state based on user input
     */
    updateConversationState(userText) {
        const lowerText = userText.toLowerCase();

        // Check for medication pickup confirmation
        if ((lowerText.includes('pick') || lowerText.includes('got') || lowerText.includes('have')) &&
            (lowerText.includes('medication') || lowerText.includes('prescription'))) {
            this.conversationState.medicationPickedUp = true;
            console.log('[PatientBot] State updated: medication picked up');
        }

        // Check for dosage/schedule confirmation
        if ((lowerText.includes('once') || lowerText.includes('daily') || lowerText.includes('day') ||
             lowerText.includes('regularly') || lowerText.includes('schedule') || lowerText.includes('morning') ||
             lowerText.includes('evening') || lowerText.includes('taking')) &&
            (lowerText.includes('taking') || lowerText.includes('yes') || lowerText.includes('am') ||
             lowerText.includes('every'))) {
            this.conversationState.dosageDiscussed = true;
            console.log('[PatientBot] State updated: dosage discussed');
        }

        // Check for \"no problems/issues\" responses - these should complete adherence
        if ((lowerText.includes('no') &&
             (lowerText.includes('problem') || lowerText.includes('issue') || lowerText.includes('side effect'))) ||
            (lowerText.includes('fine') || lowerText.includes('good') || lowerText.includes('well') ||
             lowerText.includes('everything is good') || lowerText.includes('managing well'))) {
            this.conversationState.adherenceCompleted = true;
            console.log('[PatientBot] State updated: adherence completed (no problems indicated)');
        }

        // Check for scheduling-related responses
        if (lowerText.includes('schedule') || lowerText.includes('appointment') ||
            lowerText.includes('book') || lowerText.includes('available')) {
            this.conversationState.schedulingStarted = true;
            console.log('[PatientBot] State updated: scheduling started');
        }
    }
    
    /**
     * Triage Agent - Initial routing and conversation management
     */
    async callTriageAgent(userInput) {
        try {
            const lastBotMessage = this.conversationHistory[this.conversationHistory.length - 2]?.content || 'None';

            // Create enhanced context for triage decision
            const conversationContext = `
**Conversation State:**
- Medication picked up: ${this.conversationState.medicationPickedUp}
- Dosage discussed: ${this.conversationState.dosageDiscussed}
- Adherence completed: ${this.conversationState.adherenceCompleted}
- Scheduling started: ${this.conversationState.schedulingStarted}

**Last bot message:** \"${lastBotMessage}\"
**User message:** \"${userInput}\"

**Routing Priority:**
1. If adherence is completed, prefer ROUTE_TO_SCHEDULING
2. If medication/adherence topics are still active, prefer ROUTE_TO_ADHERENCE
3. Use standard routing rules for new topics
`;

            const triagePrompt = this.getTriageAgentPrompt();
            const response = await this.callOpenAI(triagePrompt, [{ role: 'user', content: conversationContext }], false);
            
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
        try {
            // Get the patient's primary medication
            const primaryMedication = this.patientRecord.prescriptions?.[0] || {
                medicationName: this.patientRecord.primaryMedication || 'prescribed medication',
                dosage: this.patientRecord.dosage || 'As prescribed',
                frequency: this.patientRecord.frequency || 'As prescribed'
            };
            
            const medicationDetails = `${primaryMedication.medicationName} ${primaryMedication.dosage}, taken ${primaryMedication.frequency}`;

            // Check if user response indicates completion (no issues)
            const userResponse = userInput.toLowerCase();
            
            // Non-severe side effect handling (headache, fever, etc.)
            if (userResponse.includes('headache') || userResponse.includes('fever')) {
                this.conversationState.adherenceCompleted = true;
                console.log('[PatientBot] Adherence completed, moving to scheduling agent');
                return `Thank you for sharing. I'll notify Dr. ${this.patientRecord.doctorName}'s team about your headache and fever. Now, let's schedule your follow-up appointment with Dr. ${this.patientRecord.doctorName}. Are you available to do that now?`;
            }
            
            if ((userResponse.includes('no') && (userResponse.includes('problem') || userResponse.includes('side effect') || userResponse.includes('issue'))) ||
                (userResponse.includes('fine') || userResponse.includes('good') || userResponse.includes('well')) ||
                (userResponse.includes('everything is good') || userResponse.includes('managing well')) ||
                (userResponse.includes('regular') && userResponse.includes('taking'))) {
                // User indicates no issues, transition to scheduling
                this.conversationState.adherenceCompleted = true;
                console.log('[PatientBot] Adherence completed due to no problems indicated');
                return `Perfect! It sounds like you're managing your medication well. The last thing is to schedule your follow-up appointment with Dr. ${this.patientRecord.doctorName}. Are you available to do that now?`;
            }

            const adherencePrompt = this.getAdherenceAgentPrompt();
            const response = await this.callOpenAI(adherencePrompt, this.conversationHistory, false);
            
            // Check if adherence is completed based on response content
            if (this.isAdherenceComplete(response.content)) {
                this.conversationState.adherenceCompleted = true;
                this.activeAgent = 'scheduling';
                
                // Save adherence data
                const adherenceData = this.extractAdherenceData(response.content);
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
        try {
            const schedulingPrompt = this.getSchedulingAgentPrompt();
            
            if (!this.conversationState.schedulingStarted) {
                this.conversationState.schedulingStarted = true;
                return `Great! Let's book your follow-up with Dr. ${this.patientRecord.doctorName}. What days work for you?`;
            }
            
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
                    if (typeof this.schedulingPlugin[functionName] === 'function') {
                        toolResult = await this.schedulingPlugin[functionName](...Object.values(functionArgs));
                    } else {
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
                            time: { type: 'string', description: 'The appointment time (e.g., \"9:00 AM\").' }
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
        return `You are a precise internal routing agent. Analyze the user's message and respond with ONLY a routing command.

**Priority 1: Safety Override**
- If user input contains keywords of severe distress (\"breathless,\" \"dizzy,\" \"chest pain,\" \"can't breathe,\" \"emergency\") -> \"ROUTE_TO_SAFETY\"

**Priority 2: Completion Detection**
- If user indicates NO PROBLEMS, NO ISSUES, or everything is FINE/GOOD/WELL with medication -> \"ROUTE_TO_SCHEDULING\"
- Look for phrases: \"no problems\", \"no issues\", \"fine\", \"good\", \"well\", \"no side effects\", \"everything is good\", \"managing well\"

**Priority 3: Task-Oriented Requests**
- **User asks about medication**, prescriptions, side effects, doses, how to take medicine, pills, meds, \"my medication\", \"medication details\", \"prescription\", \"taking\", \"picked up\", \"pharmacy\" -> \"ROUTE_TO_ADHERENCE\"
- **User asks about appointments**, scheduling, booking, calendar, visits, rescheduling, canceling -> \"ROUTE_TO_SCHEDULING\"

**Priority 4: Affirmative Responses to Medication Questions**
- If user responds with \"yes\", \"no\", \"I have\", \"I picked\", \"I got\", \"I took\", \"I am taking\", \"already\", \"picked up\", \"paid\" in context of medication -> \"ROUTE_TO_ADHERENCE\"

**Priority 5: General Conversation / Unclear Intent**
- If the user provides a simple greeting, confirmation, or a non-specific statement, or if the intent is truly unclear -> \"ROUTE_TO_FALLBACK\"

Respond with ONLY the routing command. Do not add any other text.`;
    }
    
    getAdherenceAgentPrompt() {
        const primaryMedication = this.patientRecord.prescriptions?.[0] || {
            medicationName: this.patientRecord.primaryMedication || 'prescribed medication',
            dosage: this.patientRecord.dosage || 'As prescribed',
            frequency: this.patientRecord.frequency || 'As prescribed'
        };
        
        const medicationDetails = `${primaryMedication.medicationName} ${primaryMedication.dosage}, taken ${primaryMedication.frequency}`;
        
        return `You are Jenny, an AI assistant calling on behalf of Dr. ${this.patientRecord.doctorName}. You initiated this post-discharge follow-up call.

**Patient Context:**
- Patient Name: ${this.patientRecord.patientName}
- Doctor: Dr. ${this.patientRecord.doctorName}
- Medication: ${primaryMedication.medicationName}
- Prescription Details: ${medicationDetails}

**Conversation Awareness:**
- Read the conversation history. If the patient has already confirmed they have their medication, DO NOT ask if they have picked it up. Skip directly to the dosage check.

**TONE AND PROFESSIONALISM:**
- Speak warmly and respectfully, like a supportive medical assistant.
- Use brief, conversational language — avoid sounding scripted or robotic.
- Be reassuring and calm, especially when discussing symptoms or care instructions.
- Use simple phrasing and contractions (e.g., \"you've,\" \"let's,\" \"I'm glad\") to sound more natural.
- Maintain a lightly casual tone, like you're here to help — not to interrogate.

**COMPLETION DETECTION:**
- If the patient indicates they have NO PROBLEMS, NO ISSUES, NO SIDE EFFECTS, or that everything is FINE/GOOD/WELL with their medication, immediately transition to scheduling
- Look for phrases like: \"no problems\", \"no issues\", \"fine\", \"good\", \"well\", \"no side effects\", \"everything is good\"
- When transitioning, say: \"Great! Sounds like you're on track with your meds. Can we go ahead and schedule your follow-up with Dr. ${this.patientRecord.doctorName} now?\"

**Conversation Structure (Only if issues need to be explored):**
1.  **Initial Check:** If not already discussed, ask: \"Have you picked up your ${primaryMedication.medicationName} prescription yet?\"
2.  **Dosage/Timing Check:** Verify how they are taking the medication. Be specific about the prescribed dosage.
    - Example: \"The instructions are for ${medicationDetails}. How's that schedule going for you?\"
3.  **Quick Issue Check:** Ask directly: \"Any side effects or problems with your ${primaryMedication.medicationName}?\"
4.  **If NO ISSUES:** Immediately transition to scheduling using the completion phrase above
5.  **If ISSUES MENTIONED:**
    - **Severe Side Effects:** Use emergency response, then immediately ask: \"Would you like help scheduling your follow-up with Dr. ${this.patientRecord.doctorName}?\"
    - **Non-Urgent Issues:** Acknowledge and inform the patient you will document the issue for Dr. ${this.patientRecord.doctorName}'s team.
6.  **End of Adherence Flow:** Once any issues are addressed, transition to scheduling: \"The last thing is to schedule your follow-up appointment with Dr. ${this.patientRecord.doctorName}. Are you available to do that now?\"

**PRIORITY:** Always look for completion signals first. Don't unnecessarily prolong the adherence conversation if the patient indicates no problems.`;
    }
    
    getSchedulingAgentPrompt() {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const todayISO = today.toISOString().split('T')[0];
        const tomorrowISO = tomorrow.toISOString().split('T')[0];
        
        return `You are Jenny, an AI assistant calling on behalf of Dr. ${this.patientRecord.doctorName}. You help ${this.patientRecord.patientName} book, reschedule, or cancel follow-up appointments with Dr. ${this.patientRecord.doctorName}. You cannot assist with any other requests.

**IMPORTANT: CURRENT DATE CONTEXT**
- Today's date is: ${today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} (${todayISO})
- \"tomorrow\" = ${tomorrowISO}
- Patient was discharged recently and needs a follow-up appointment

**Business Hours (Clinic Time Zone):**
- Available slots: 9:00 AM, 11:00 AM, 2:00 PM

**Your Tool-Use Protocol:**
Use the scheduling tools to help ${this.patientRecord.patientName} book their follow-up appointment with Dr. ${this.patientRecord.doctorName}.`;
    }
    
    /**
     * Conversation state checkers
     */
    isTriageComplete(response) {
        const completionIndicators = [
            'medication', 'adherence', 'how have you been taking',
            "let's talk about", 'moving on', 'now about'
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
            welcome: `<speak version=\"1.0\" xml:lang=\"en-US\">
                <voice name=\"en-US-JennyNeural\" style=\"customerservice\" styledegree=\"0.8\">
                    <prosody rate=\"0.9\" pitch=\"medium\">
                        ${text}
                    </prosody>
                </voice>
            </speak>`,
            
            adherence: `<speak version=\"1.0\" xml:lang=\"en-US\">
                <voice name=\"en-US-JennyNeural\" style=\"empathetic\">
                    <prosody rate=\"0.85\" pitch=\"medium\">
                        ${text.replace(/(\\d+)\\s*(mg|milligrams?|mcg|micrograms?)/gi,
                            '<emphasis level=\"moderate\">$1 $2</emphasis>')
                            .replace(/(once|twice|three times|four times)\\s+(daily|a day|per day)/gi,
                            '<emphasis level=\"moderate\">$1 $2</emphasis>')
                            .replace(/(levothyroxine|metformin|amoxicillin|lisinopril|ibuprofen)/gi,
                            '<emphasis level=\"moderate\">$1</emphasis>')}
                    </prosody>
                </voice>
            </speak>`,
            
            scheduling: `<speak version=\"1.0\" xml:lang=\"en-US\">
                <voice name=\"en-US-JennyNeural\" style=\"customerservice\">
                    <prosody rate=\"0.9\">
                        ${text.replace(/(\\d{1,2}:\\d{2}\\s*(AM|PM))/gi,
                            '<emphasis level=\"strong\">$1</emphasis>')}
                    </prosody>
                </voice>
            </speak>`,
            
            emergency: `<speak version=\"1.0\" xml:lang=\"en-US\">
                <voice name=\"en-US-JennyNeural\" style=\"urgent\">
                    <prosody rate=\"1.0\" pitch=\"high\">
                        <emphasis level=\"strong\">${text}</emphasis>
                    </prosody>
                </voice>
            </speak>`,
            
            normal: `<speak version=\"1.0\" xml:lang=\"en-US\">
                <voice name=\"en-US-JennyNeural\" style=\"customerservice\">
                    <prosody rate=\"0.9\" pitch=\"medium\">
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
            medicationPickedUp: false,
            dosageDiscussed: false,
            adherenceCompleted: false,
            schedulingStarted: false,
            schedulingCompleted: false,
            triageCompleted: false,
            currentMedication: null,
            pendingAppointment: null,
            callCompleted: false
        };
        console.log(`[PatientBot] Conversation reset for ${this.patientRecord.patientName}`);
    }
}

module.exports = { PatientBot };
