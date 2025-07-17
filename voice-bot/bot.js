// Healthcare Voice Agent with Triage Routing
// Azure OpenAI integration with error handling and security

const { ActivityHandler, MessageFactory } = require('botbuilder');
const axios = require('axios');
const { SchedulingPlugin } = require('./schedulingPlugin');
require('dotenv').config();

const requiredEnvVars = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_DEPLOYMENT_NAME'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
    console.error(`[Bot] Missing required environment variables: ${missingEnvVars.join(', ')}`);
    throw new Error('Required environment variables are missing');
}

const AZURE_OPENAI_CONFIG = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_KEY,
    deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
    apiVersion: '2024-05-01-preview',
    maxRetries: 3,
    retryDelayMs: 1000,
    timeoutMs: 30000
};

// Shared instructions for all healthcare agent specialists
const SHARED_INSTRUCTIONS = `
### SHARED BEHAVIOR AND RULES ###
- Your name is "Jenny." You must act as a single, unified AI assistant, regardless of the task.
- Your tone is always friendly, professional, and reassuring.
- Your primary goal is to help the patient with their specific request.
- CRITICAL: If the conversation history shows you were just handed off from another specialist, you MUST briefly acknowledge the previous topic before proceeding. Example: "I understand you were just discussing your medication. I can now help you schedule an appointment."
- CRITICAL: The safety rails for medical advice and emergency escalation are always active. If the user mentions severe side effects or asks for medical advice, you must stop your current task and provide the scripted safety response.
- Protect patient privacy and confidentiality in all interactions.
- Keep your responses clear and as concise as possible.

### SPEECH RECOGNITION AWARENESS ###
- Be patient and understanding if the patient's speech seems unclear or has minor errors - they may be using voice input.
- If you receive text that seems like it might have speech recognition errors (missing letters, similar-sounding words), try to understand the intent.
- Common speech recognition issues to be aware of:
  * "appointment" might come through as "appointement" or "apointment"
  * "schedule" might be "shedule" or "scedule"  
  * "reschedule" might be "reshcedule"
  * "doctor" might be "docter"
  * "prescription" might be "perscription"
  * Time expressions like "tomorrow" might be "tomorow"
- Always confirm important details like dates and times to ensure accuracy.
- If you're unsure about what the patient said, politely ask for clarification: "I want to make sure I understand correctly..."
`;

// Medication adherence agent prompt
const ADHERENCE_AGENT_PROMPT = `${SHARED_INSTRUCTIONS}

### YOUR CURRENT SPECIALTY: MEDICATION ADHERENCE ###
You are checking in with a patient about their new medication protocol.

**Your Conversational Protocol for this task:**
1.  **Introduction:** If starting the conversation, introduce yourself and the reason for your call.
2.  **Medication Check:** Ask if they have started taking their new medication.
3.  **Protocol Adherence Check:** Verify they are following the correct dosage and frequency.
4.  **Protocol Reinforcement:** Gently remind them of the importance of the protocol.
5.  **Question Triage:** Ask if they have any non-urgent questions for the nursing team.
`;

// Cached scheduling prompt to avoid regeneration
let CACHED_SCHEDULING_AGENT_PROMPT = null;
let PROMPT_CACHE_DATE = null;

// Dynamic scheduling agent prompt with current date context
function getSchedulingAgentPrompt() {
    const today = new Date();
    const currentDateString = today.toDateString();
    
    if (!CACHED_SCHEDULING_AGENT_PROMPT || PROMPT_CACHE_DATE !== currentDateString) {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const todayISO = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
        const tomorrowISO = tomorrow.getFullYear() + '-' + String(tomorrow.getMonth() + 1).padStart(2, '0') + '-' + String(tomorrow.getDate()).padStart(2, '0');
        
        CACHED_SCHEDULING_AGENT_PROMPT = `${SHARED_INSTRUCTIONS}

### YOUR CURRENT SPECIALTY: APPOINTMENT SCHEDULING ###
You are helping a patient to book, reschedule, cancel, or check their appointments.

**IMPORTANT: CURRENT DATE CONTEXT**
Today's date is: ${today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} (${todayISO})

When users say:
- "tomorrow" = ${tomorrowISO}
- "today" = ${todayISO}
- "next week" = refer to dates 7 days from today

**Your available tools for this task:**
- findAvailability: Checks available time slots for a specific date (format: YYYY-MM-DD).
- createAppointment: Books a new appointment for a patient (requires appointmentDateTime in format: YYYY-MM-DDTHH:MM:SS).
- listAppointments: Views existing appointments for a specific date (format: YYYY-MM-DD).
- cancelAppointment: Cancels an existing appointment (requires date and time).
- rescheduleAppointment: Moves an existing appointment to a new date/time (cancels old, creates new).

**Your Tool-Use Protocol for this task:**

**For BOOKING new appointments:**
1.  When a user wants to book, first parse their date request (e.g., "tomorrow" = ${tomorrowISO}).
2.  Use the 'findAvailability' tool with that date in YYYY-MM-DD format.
3.  Present the available slots from the tool and wait for the user to choose.
4.  Once a time is chosen, combine the date and time to create appointmentDateTime (e.g., "${tomorrowISO}T15:00:00" for 3:00 PM tomorrow).
5.  Use the 'createAppointment' tool with the full appointmentDateTime.
6.  Always confirm the final booking details with the user using the correct date.

**For CANCELING appointments:**
1.  First use 'listAppointments' to show what appointments exist for the relevant date.
2.  If the user specifies the date and time, use 'cancelAppointment' directly.
3.  If they only mention time ("cancel my 9 AM"), assume they mean today unless they specify otherwise.
4.  Always confirm the cancellation details.

**For RESCHEDULING appointments:**
1.  First identify the original appointment (date and time) that needs to be moved.
2.  When user provides only a new time (e.g., "to 5:00 PM"), assume the same date as the original appointment.
3.  When user provides a new date, ask for the preferred time if not specified.
4.  Always use 'findAvailability' to check if the new time slot is available before rescheduling.
5.  Format the newDateTime parameter correctly: combine the new date + time into ISO format (YYYY-MM-DDTHH:MM:SS).
   - Example: For July 15th at 5:00 PM, use "2025-07-15T17:00:00"
   - Convert 12-hour to 24-hour format: 5:00 PM = 17:00
6.  Use 'rescheduleAppointment' with originalDate, originalTime, and newDateTime.
7.  IMPORTANT: If the reschedule operation succeeds, acknowledge both the cancellation of the old appointment AND the creation of the new one.
8.  If any communication errors occur AFTER a successful reschedule, still confirm the success to the patient.

**RESCHEDULING Example:**
User: "Reschedule my 3:30 PM appointment on July 15th to 5:00 PM"
Steps: originalDate="2025-07-15", originalTime="3:30 PM", newDateTime="2025-07-15T17:00:00"

**Error Recovery for Rescheduling:**
- If you receive a "Successfully rescheduled" message from the tool but encounter communication issues afterward, always confirm the success to the patient
- Never leave a patient uncertain about whether their rescheduling worked
- If in doubt, ask them to check their calendar and offer to help further

**Patient Communication Standards:**
- Always acknowledge the specific appointment being discussed
- Confirm availability before making changes
- Provide clear confirmation of what was changed
- If errors occur, explain clearly and offer alternatives

**Business Hours Available:**
9:00 AM, 10:00 AM, 10:30 AM, 11:00 AM, 2:00 PM, 3:00 PM, 4:00 PM, 5:00 PM
`;
        PROMPT_CACHE_DATE = currentDateString;
    }
    
    return CACHED_SCHEDULING_AGENT_PROMPT;
}

// Triage agent for routing user requests
const TRIAGE_AGENT_PROMPT = `You are an internal routing agent. Your only job is to analyze the user's text and output a routing command.
- If the user's request is about medication, prescriptions, side effects, or following doctor's orders, respond with only the text: "ROUTE_TO_ADHERENCE"
- If the user's request is about booking, changing, or checking an appointment or the calendar, respond with only the text: "ROUTE_TO_SCHEDULING"
- If the user's intent is unclear, ask a clarifying question.`;

class EchoBot extends ActivityHandler {
    constructor() {
        super();
        
        // Initialize state management
        this.activeAgent = 'triage'; // Start with triage
        this.conversationHistory = [];
        this.schedulingPlugin = new SchedulingPlugin();
        this.conversationId = null;
        this.hasSeenUser = new Set(); // Track which conversations have seen the user
        
        // Initialize rate limiting
        this.rateLimiter = {
            requests: 0,
            resetTime: Date.now() + 60000 // Reset every minute
        };
        
        console.log('[Bot] Healthcare voice agent initialized successfully');
        console.log('[Bot] Active agent: triage');

        // Message handler with error handling and welcome logic
        this.onMessage(async (context, next) => {
            const userText = context.activity.text;
            this.conversationId = context.activity.conversation.id;
            
            // Send welcome message for new conversations
            if (!this.hasSeenUser.has(this.conversationId)) {
                this.hasSeenUser.add(this.conversationId);
                try {
                    const welcomeMessage = 'Hello! This is Jenny from the post-discharge care team. I\'m here to help with your medication follow-up or schedule appointments. How can I assist you today?';
                    await context.sendActivity(MessageFactory.text(welcomeMessage, welcomeMessage));
                    console.log('[Bot] First-interaction welcome message sent');
                } catch (error) {
                    console.error('[Bot] Error sending first-interaction welcome:', error.message);
                }
            }
            
            if (!userText || userText.trim().length === 0) {
                await context.sendActivity('Please provide a message.');
                await next();
                return;
            }

            // Rate limiting check
            if (!this.checkRateLimit()) {
                await context.sendActivity('Please wait a moment before sending another message.');
                await next();
                return;
            }

            try {
                const response = await this.processMessage(userText);
                await context.sendActivity(MessageFactory.text(response, response));
                
            } catch (error) {
                console.error('[Bot] Error processing message:', {
                    error: error.message,
                    stack: error.stack,
                    conversationId: this.conversationId,
                    activeAgent: this.activeAgent
                });
                
                // Provide user-friendly error response
                const errorResponse = this.getErrorResponse(error);
                await context.sendActivity(MessageFactory.text(errorResponse, errorResponse));
            }

            await next();
        });

        // Welcome message handler
        this.onMembersAdded(async (context, next) => {
            for (const member of context.activity.membersAdded) {
                if (member.id !== context.activity.recipient.id) {
                    try {
                        // Send welcome message for new users
                        const welcomeMessage = 'Hello! This is Jenny from the post-discharge care team. I\'m here to help with your medication follow-up or schedule appointments. How can I assist you today?';
                        await context.sendActivity(MessageFactory.text(welcomeMessage, welcomeMessage));
                        
                        console.log('[Bot] Welcome message sent successfully');
                    } catch (error) {
                        console.error('[Bot] Error sending welcome message:', error.message);
                        await context.sendActivity('Welcome! How can I help you today?');
                    }
                }
            }
            await next();
        });
    }

    // Rate limiting check (max 30 requests per minute)
    checkRateLimit() {
        const now = Date.now();
        
        if (now > this.rateLimiter.resetTime) {
            this.rateLimiter.requests = 0;
            this.rateLimiter.resetTime = now + 60000;
        }
        
        // Check if within limits (max 30 requests per minute)
        if (this.rateLimiter.requests >= 30) {
            return false;
        }
        
        this.rateLimiter.requests++;
        return true;
    }

    // Process message through appropriate agent (triage → adherence/scheduling)
    async processMessage(userText) {
        let response;

        // Reset to triage for topic changes
        if (this.activeAgent !== 'triage' && this.shouldResetToTriage(userText)) {
            console.log('[Bot] Resetting to triage for new topic');
            this.activeAgent = 'triage';
            this.conversationHistory = [];
        }

        if (this.activeAgent === 'triage') {
            // Use triage agent to determine routing
            response = await this.callTriageAgent(userText);
            
            if (response.includes('ROUTE_TO_ADHERENCE')) {
                this.activeAgent = 'adherence';
                this.conversationHistory = [];
                console.log('[Bot] Agent switched: adherence');
                // Process the original message with adherence agent
                response = await this.callAdherenceAgent(userText);
            } else if (response.includes('ROUTE_TO_SCHEDULING')) {
                this.activeAgent = 'scheduling';
                this.conversationHistory = [];
                console.log('[Bot] Agent switched: scheduling');
                // Process the original message with scheduling agent
                response = await this.handleSchedulingWithTools(userText);
            }
            // If no routing decision, send triage response (clarifying question)
        } else if (this.activeAgent === 'adherence') {
            response = await this.callAdherenceAgent(userText);
        } else if (this.activeAgent === 'scheduling') {
            response = await this.handleSchedulingWithTools(userText);
        }

        return response;
    }

    // Determine if we should reset to triage for topic changes
    shouldResetToTriage(userText) {
        const lowerText = userText.toLowerCase();
        
        // Keywords that indicate a topic change
        const schedulingKeywords = ['appointment', 'schedule', 'book', 'calendar', 'see doctor', 'visit'];
        const medicationKeywords = ['medication', 'medicine', 'prescription', 'pill', 'dose', 'side effect'];
        
        // If currently in adherence mode but user mentions scheduling
        if (this.activeAgent === 'adherence' && schedulingKeywords.some(keyword => lowerText.includes(keyword))) {
            return true;
        }
        
        // If currently in scheduling mode but user mentions medication
        if (this.activeAgent === 'scheduling' && medicationKeywords.some(keyword => lowerText.includes(keyword))) {
            return true;
        }
        
        return false;
    }

    /**
     * Get user-friendly error response based on error type
     * @param {Error} error - The error object
     * @returns {string} - User-friendly error message
     */
    getErrorResponse(error) {
        if (error.message.includes('timeout')) {
            return 'I apologize, but the response is taking longer than expected. Please try again.';
        } else if (error.message.includes('rate limit')) {
            return 'I need to slow down a bit. Please wait a moment before trying again.';
        } else if (error.message.includes('authentication')) {
            return 'I\'m having trouble connecting to my services. Please try again later.';
        } else {
            return 'I apologize, but I encountered an error. Please try again or contact support if the issue persists.';
        }
    }

    /**
     * Call the triage agent to determine routing
     * @param {string} userText - The user's message
     * @returns {Promise<string>} - The triage response
     */
    async callTriageAgent(userText) {
        try {
            const response = await this.callOpenAI(TRIAGE_AGENT_PROMPT, [{ role: 'user', content: userText }], false);
            return response.content;
        } catch (error) {
            console.error('[Bot] Triage agent error:', error.message);
            throw new Error('Failed to process triage request');
        }
    }

    /**
     * Call the adherence agent for medication-related conversations
     * @param {string} userText - The user's message
     * @returns {Promise<string>} - The adherence agent response
     */
    async callAdherenceAgent(userText) {
        try {
            // Add to conversation history
            this.conversationHistory.push({ role: 'user', content: userText });
            
            const response = await this.callOpenAI(ADHERENCE_AGENT_PROMPT, this.conversationHistory, false);
            
            // Validate response content
            if (!response || !response.content) {
                throw new Error('Invalid response from adherence agent');
            }
            
            this.conversationHistory.push({ role: 'assistant', content: response.content });
            return response.content;
            
        } catch (error) {
            console.error('[Bot] Adherence agent error:', error.message);
            throw new Error('Failed to process adherence request');
        }
    }

    /**
     * Handle scheduling conversations with tool support
     * @param {string} userText - The user's message
     * @returns {Promise<string>} - The scheduling response
     */
    async handleSchedulingWithTools(userText) {
        try {
            // Add the new user message to the conversation history
            this.conversationHistory.push({ role: 'user', content: userText });

            // Call the OpenAI model, which may respond with text or a tool call request
            const aiResponse = await this.callOpenAI(getSchedulingAgentPrompt(), this.conversationHistory, true);

            // Validate response
            if (!aiResponse) {
                throw new Error('Invalid response from scheduling agent');
            }

            // --- Check if the AI wants to call a tool ---
            if (aiResponse.tool_calls) {
                const toolCall = aiResponse.tool_calls[0];
                const functionName = toolCall.function.name;
                
                // Validate tool call
                if (!functionName || !toolCall.function.arguments) {
                    throw new Error('Invalid tool call format');
                }

                let functionArgs;
                try {
                    functionArgs = JSON.parse(toolCall.function.arguments);
                } catch (parseError) {
                    console.error('[Bot] Tool arguments parsing error:', parseError.message);
                    throw new Error('Invalid tool arguments format');
                }

                // Only log function name for security - no sensitive patient data
                console.log(`[Bot] Tool executed: ${functionName}`);

                // Execute the requested tool function with error handling
                let toolResult = '';
                try {
                    if (functionName === 'findAvailability') {
                        if (!functionArgs.date) {
                            throw new Error('Missing required date parameter');
                        }
                        toolResult = await this.schedulingPlugin.findAvailability(functionArgs.date);
                    } else if (functionName === 'createAppointment') {
                        if (!functionArgs.appointmentDateTime) {
                            throw new Error('Missing required appointmentDateTime parameter');
                        }
                        // Use provided patient name or default
                        const patientName = functionArgs.patientName || 'Patient';
                        toolResult = await this.schedulingPlugin.createAppointment(functionArgs.appointmentDateTime, patientName);
                    } else if (functionName === 'listAppointments') {
                        if (!functionArgs.date) {
                            throw new Error('Missing required date parameter');
                        }
                        toolResult = await this.schedulingPlugin.listAppointments(functionArgs.date);
                    } else if (functionName === 'cancelAppointment') {
                        if (!functionArgs.date || !functionArgs.time) {
                            throw new Error('Missing required date or time parameter');
                        }
                        toolResult = await this.schedulingPlugin.cancelAppointment(functionArgs.date, functionArgs.time);
                    } else if (functionName === 'rescheduleAppointment') {
                        if (!functionArgs.originalDate || !functionArgs.originalTime || !functionArgs.newDateTime) {
                            throw new Error('Missing required originalDate, originalTime, or newDateTime parameter');
                        }
                        // Use provided patient name or default
                        const patientName = functionArgs.patientName || 'Patient';
                        toolResult = await this.schedulingPlugin.rescheduleAppointment(
                            functionArgs.originalDate, 
                            functionArgs.originalTime, 
                            functionArgs.newDateTime, 
                            patientName
                        );
                    } else {
                        throw new Error(`Unknown function: ${functionName}`);
                    }
                } catch (toolError) {
                    console.error(`[Bot] Tool execution error (${functionName}):`, toolError.message);
                    toolResult = `Error: ${toolError.message}`;
                }

                // Add the tool call and its result to the history
                this.conversationHistory.push({ role: 'assistant', content: null, tool_calls: aiResponse.tool_calls });
                this.conversationHistory.push({ role: 'tool', tool_call_id: toolCall.id, name: functionName, content: toolResult });

                // Call OpenAI *again* with the tool's result so it can formulate a natural language response
                console.log('[Bot] Making final call to OpenAI with history length:', this.conversationHistory.length);
                
                let finalResponse;
                try {
                    finalResponse = await this.callOpenAI(getSchedulingAgentPrompt(), this.conversationHistory, true);
                } catch (finalCallError) {
                    console.error('[Bot] Final OpenAI call failed:', finalCallError.message);
                    
                    // Special handling for rescheduling operations that may have partially succeeded
                    if (functionName === 'rescheduleAppointment' && toolResult.includes('Successfully rescheduled')) {
                        const successMessage = "Your appointment has been successfully rescheduled. Please let me know if you need anything else!";
                        this.conversationHistory.push({ role: 'assistant', content: successMessage });
                        return successMessage;
                    }
                    
                    // For other operations that succeeded, provide a generic success response
                    if (toolResult.includes('successfully') || toolResult.includes('Successfully')) {
                        const successMessage = "I've processed your request successfully. Please let me know if you need anything else!";
                        this.conversationHistory.push({ role: 'assistant', content: successMessage });
                        return successMessage;
                    }
                    
                    // If the tool operation itself failed, return the error
                    if (toolResult.includes('Error:') || toolResult.includes('Failed')) {
                        this.conversationHistory.push({ role: 'assistant', content: toolResult });
                        return toolResult;
                    }
                    
                    // Final fallback for unexpected errors
                    const fallbackMessage = "I encountered a communication issue, but your request may have been processed. Please check your calendar and let me know if you need assistance.";
                    this.conversationHistory.push({ role: 'assistant', content: fallbackMessage });
                    return fallbackMessage;
                }
                
                // The callOpenAI function returns the message object from OpenAI
                if (!finalResponse || !finalResponse.content) {
                    console.error('[Bot] Invalid final response - finalResponse:', JSON.stringify(finalResponse, null, 2));
                    
                    // Enhanced fallback logic based on tool result
                    if (toolResult.includes('successfully') || toolResult.includes('Successfully')) {
                        const successMessage = "I've processed your request successfully. Please let me know if you need anything else!";
                        this.conversationHistory.push({ role: 'assistant', content: successMessage });
                        return successMessage;
                    } else {
                        // Fallback: return a generic message
                        const genericMessage = "I've processed your request. Please let me know if you need anything else!";
                        this.conversationHistory.push({ role: 'assistant', content: genericMessage });
                        return genericMessage;
                    }
                }
                
                this.conversationHistory.push({ role: 'assistant', content: finalResponse.content });
                return finalResponse.content;
            } else {
                // --- If no tool call, just send the AI's text response ---
                if (!aiResponse.content) {
                    throw new Error('No content in AI response');
                }
                
                this.conversationHistory.push({ role: 'assistant', content: aiResponse.content });
                return aiResponse.content;
            }
            
        } catch (error) {
            console.error('[Bot] Scheduling error:', error.message);
            throw new Error('Failed to process scheduling request');
        }
    }

    /**
     * Calls the Azure OpenAI API with the current conversation history and optional tools.
     * Implements retry logic with exponential backoff for better reliability.
     * @param {string} systemPrompt The system prompt defining the agent's role.
     * @param {Array} history The history of the conversation.
     * @param {boolean} includeTools Whether to include scheduling tools (default: true for scheduling agent).
     * @returns {Promise<object>} The full message object from the AI, which could include text or tool calls.
     */
    async callOpenAI(systemPrompt, history, includeTools = true) {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history
        ];

        // Define the tools available to the AI (only for scheduling agent)
        const tools = includeTools ? [
            {
                type: 'function',
                function: {
                    name: 'findAvailability',
                    description: 'Checks the calendar for available appointment slots on a specific date.',
                    parameters: {
                        type: 'object',
                        properties: { 
                            date: { 
                                type: 'string', 
                                description: 'The date to check, in YYYY-MM-DD format.',
                                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
                            } 
                        },
                        required: ['date'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'createAppointment',
                    description: 'Books a new appointment in the calendar for a patient.',
                    parameters: {
                        type: 'object',
                        properties: {
                            appointmentDateTime: { 
                                type: 'string', 
                                description: 'The appointment start time in ISO 8601 format (e.g., "2025-07-15T14:00:00").',
                                pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$'
                            },
                            patientName: { 
                                type: 'string', 
                                description: "The patient's name.",
                                maxLength: 100
                            },
                        },
                        required: ['appointmentDateTime', 'patientName'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'listAppointments',
                    description: 'Lists all appointments for a specific date to verify bookings.',
                    parameters: {
                        type: 'object',
                        properties: { 
                            date: { 
                                type: 'string', 
                                description: 'The date to check appointments for, in YYYY-MM-DD format.',
                                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
                            } 
                        },
                        required: ['date'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'cancelAppointment',
                    description: 'Cancels an existing appointment on a specific date and time.',
                    parameters: {
                        type: 'object',
                        properties: {
                            date: { 
                                type: 'string', 
                                description: 'The date of the appointment to cancel, in YYYY-MM-DD format.',
                                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
                            },
                            time: { 
                                type: 'string', 
                                description: 'The time of the appointment to cancel (e.g., "9:00 AM", "14:00", "2:00 PM").'
                            }
                        },
                        required: ['date', 'time'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'rescheduleAppointment',
                    description: 'Reschedules an existing appointment by canceling the old one and creating a new one.',
                    parameters: {
                        type: 'object',
                        properties: {
                            originalDate: { 
                                type: 'string', 
                                description: 'The date of the original appointment to reschedule, in YYYY-MM-DD format.',
                                pattern: '^\\d{4}-\\d{2}-\\d{2}$'
                            },
                            originalTime: { 
                                type: 'string', 
                                description: 'The time of the original appointment to reschedule (e.g., "9:00 AM", "14:00", "2:00 PM").'
                            },
                            newDateTime: { 
                                type: 'string', 
                                description: 'The new appointment date and time in ISO 8601 format (e.g., "2025-07-17T10:00:00").',
                                pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$'
                            },
                            patientName: { 
                                type: 'string', 
                                description: "The patient's name for the rescheduled appointment.",
                                maxLength: 100
                            }
                        },
                        required: ['originalDate', 'originalTime', 'newDateTime', 'patientName'],
                    },
                },
            },
        ] : [];

        const requestBody = {
            messages: messages,
            max_tokens: 800,
            temperature: 0.7,
            top_p: 0.95,
            frequency_penalty: 0,
            presence_penalty: 0
        };

        // Include tools when explicitly requested (for scheduling agent)
        if (includeTools) {
            requestBody.tools = tools;
            requestBody.tool_choice = 'auto';
        }

        // Implement retry logic with exponential backoff
        let lastError;
        for (let attempt = 0; attempt < AZURE_OPENAI_CONFIG.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), AZURE_OPENAI_CONFIG.timeoutMs);

                const response = await axios.post(
                    `${AZURE_OPENAI_CONFIG.endpoint}openai/deployments/${AZURE_OPENAI_CONFIG.deploymentName}/chat/completions?api-version=${AZURE_OPENAI_CONFIG.apiVersion}`,
                    requestBody,
                    {
                        headers: { 
                            'api-key': AZURE_OPENAI_CONFIG.apiKey, 
                            'Content-Type': 'application/json',
                            'User-Agent': 'Healthcare-Voice-Bot/1.0'
                        },
                        signal: controller.signal
                    }
                );

                clearTimeout(timeoutId);

                // Validate response structure
                if (!response.data || !response.data.choices || !response.data.choices[0]) {
                    throw new Error('Invalid response structure from Azure OpenAI');
                }

                const message = response.data.choices[0].message;
                if (!message) {
                    throw new Error('No message in response from Azure OpenAI');
                }

                // Log successful call (without sensitive data)
                console.log(`[Bot] Azure OpenAI call successful (attempt ${attempt + 1})`);
                return message;

            } catch (error) {
                lastError = error;
                
                // Log error details (without sensitive data)
                console.error(`[Bot] Azure OpenAI API error (attempt ${attempt + 1}):`, {
                    status: error.response?.status,
                    statusText: error.response?.statusText,
                    message: error.message,
                    isTimeout: error.name === 'AbortError'
                });

                // Check if this is a retryable error
                if (this.isRetryableError(error)) {
                    if (attempt < AZURE_OPENAI_CONFIG.maxRetries - 1) {
                        // Exponential backoff with jitter
                        const delay = AZURE_OPENAI_CONFIG.retryDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
                        console.log(`[Bot] Retrying in ${delay}ms...`);
                        await this.sleep(delay);
                        continue;
                    }
                }
                
                // Non-retryable error or max retries exceeded
                break;
            }
        }

        // All retries failed
        console.error('[Bot] Azure OpenAI API failed after all retries');
        
        // Return appropriate error response based on error type
        if (lastError.response?.status === 429) {
            throw new Error('rate limit');
        } else if (lastError.response?.status === 401 || lastError.response?.status === 403) {
            throw new Error('authentication');
        } else if (lastError.name === 'AbortError') {
            throw new Error('timeout');
        } else {
            throw new Error('API error');
        }
    }

    /**
     * Determine if an error is retryable
     * @param {Error} error - The error to check
     * @returns {boolean} - Whether the error is retryable
     */
    isRetryableError(error) {
        // Retry on network errors, timeouts, and certain HTTP status codes
        if (error.name === 'AbortError' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
            return true;
        }
        
        if (error.response) {
            const status = error.response.status;
            // Retry on server errors (5xx) and rate limiting (429)
            return status >= 500 || status === 429;
        }
        
        return false;
    }

    /**
     * Sleep for a specified duration
     * @param {number} ms - Milliseconds to sleep
     * @returns {Promise<void>}
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports.EchoBot = EchoBot;
