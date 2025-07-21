    // Healthcare Voice Agent with Triage Routing
// At the top of your bot.js file, with other requires
const fs = require('fs');
const path = require('path');
const { ActivityHandler, MessageFactory } = require('botbuilder');
const axios = require('axios');
const { SchedulingPlugin } = require('./schedulingPlugin');
require('dotenv').config();

// --- Configuration and Initialization (No Changes) ---
const requiredEnvVars = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_KEY', 'AZURE_OPENAI_DEPLOYMENT_NAME'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
    const errorMsg = `[Bot] Missing required environment variables: ${missingEnvVars.join(', ')}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
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


// --- Core Prompts and Shared Instructions ---

// =========================================================================================
// IMPROVEMENT 1: The emergency response is now a concluding instruction, not a handoff offer.
// =========================================================================================
const EMERGENCY_SAFETY_RESPONSE = "Thanks for letting me know. That could be important. If you're experiencing anything like chest pain, trouble breathing, or feeling very unwell, please call your doctor or 911 right away.";

const SHARED_INSTRUCTIONS = `
### SHARED BEHAVIOR AND RULES ###
- You are Jenny, an AI assistant calling on behalf of Dr. {Doctor_Name}. You initiated this post-discharge follow-up call.
- This is an OUTBOUND CALL - you called the patient {Patient_Name} to check on their recovery and medication adherence.
- Your role is to handle medication adherence checks and schedule follow-up appointments. You cannot connect to a live doctor or nurse.
- You are speaking with {Patient_Name}, who was recently discharged and prescribed {treatment_name}.
- Maintain a warm, respectful, and calming tone as you would in a professional healthcare call.
- CRITICAL SAFETY PROTOCOL: If the user mentions severe side effects (e.g., "dizzy," "chest pain," "can't breathe"), you must immediately stop your current task and provide the exact scripted safety response: "${EMERGENCY_SAFETY_RESPONSE}" continue the conversation without sounding dismissive. "I'm really glad you’ve been taking your medication as prescribed. Let’s also make sure you're scheduled for your follow-up appointment."
- CRITICAL HANDOFF PROTOCOL: If the conversation history shows a switch from another specialist, you MUST briefly acknowledge the previous topic before proceeding.
- CRITICAL CONFIRMATION RULE: Always confirm critical information like medication names and appointment times by reading them back to the user.
- Remember: You initiated this call to check on the patient's well-being and medication compliance.
`;

const ADHERENCE_AGENT_PROMPT = `${SHARED_INSTRUCTIONS}

### YOUR CURRENT SPECIALTY: MEDICATION ADHERENCE ###
Your goal is to be supportive and identify any issues for the nursing team to review later.

**Patient Context:**
- Patient Name: {Patient_Name}
- Doctor: Dr. {Doctor_Name}
- Medication: {treatment_name}
- Prescription Details: {medication_details}

**Conversation Awareness:**
- Read the conversation history. If the patient has already confirmed they have their medication, DO NOT ask if they have picked it up. Skip directly to the dosage check.

**TONE AND PROFESSIONALISM:**
- Speak warmly and respectfully, like a supportive medical assistant.
- Use brief, conversational language — avoid sounding scripted or robotic.
- Be reassuring and calm, especially when discussing symptoms or care instructions.
- Use simple phrasing and contractions (e.g., “you’ve,” “let’s,” “I’m glad”) to sound more natural.
- Maintain a lightly casual tone, like you're here to help — not to interrogate.

**COMPLETION DETECTION:**
- If the patient indicates they have NO PROBLEMS, NO ISSUES, NO SIDE EFFECTS, or that everything is FINE/GOOD/WELL with their medication, immediately transition to scheduling
- Look for phrases like: "no problems", "no issues", "fine", "good", "well", "no side effects", "everything is good"
- When transitioning, say: "Great! Sounds like you're on track with your meds. Can we go ahead and schedule your follow-up with Dr. {Doctor_Name} now?"

**Conversation Structure (Only if issues need to be explored):**
1.  **Initial Check:** If not already discussed, ask: "Have you picked up your {treatment_name} prescription yet?"
2.  **Dosage/Timing Check:** Verify how they are taking the medication. Be specific about the prescribed dosage.
    - Example: "The instructions are for {medication_details}. How’s that schedule going for you?"
3.  **Quick Issue Check:** Ask directly: "Any side effects or problems with your {treatment_name}?"
4.  **If NO ISSUES:** Immediately transition to scheduling using the completion phrase above
5.  **If ISSUES MENTIONED:**
    - **Severe Side Effects:** Use the EMERGENCY_SAFETY_RESPONSE, then immediately ask: "Would you like help scheduling your follow-up with Dr. {Doctor_Name}?"
    - **Non-Urgent Issues:** Acknowledge and inform the patient you will document the issue for Dr. {Doctor_Name}'s team.
6.  **End of Adherence Flow:** Once any issues are addressed, transition to scheduling: "The last thing is to schedule your follow-up appointment with Dr. {Doctor_Name}. Are you available to do that now?"

**PRIORITY:** Always look for completion signals first. Don't unnecessarily prolong the adherence conversation if the patient indicates no problems.
`;

let CACHED_SCHEDULING_AGENT_PROMPT = null;
let PROMPT_CACHE_DATE = null;

function getSchedulingAgentPrompt(patientRecord) {
    const today = new Date();
    const currentDateString = today.toDateString();

    if (!CACHED_SCHEDULING_AGENT_PROMPT || PROMPT_CACHE_DATE !== currentDateString) {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const todayISO = today.toISOString().split('T')[0];
        const tomorrowISO = tomorrow.toISOString().split('T')[0];

        // Create personalized shared instructions for scheduling
        const personalizedSharedInstructions = SHARED_INSTRUCTIONS
            .replace(/{Patient_Name}/g, patientRecord.patientName)
            .replace(/{Doctor_Name}/g, patientRecord.doctorName)
            .replace(/{treatment_name}/g, patientRecord.prescriptions[0].medicationName);

        CACHED_SCHEDULING_AGENT_PROMPT = `${personalizedSharedInstructions}

### YOUR CURRENT SPECIALTY: APPOINTMENT SCHEDULING ###
You help ${patientRecord.patientName} book, reschedule, or cancel follow-up appointments with Dr. ${patientRecord.doctorName}. You cannot assist with any other requests.

**IMPORTANT: CURRENT DATE CONTEXT**
- Today's date is: ${today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} (${todayISO})
- "tomorrow" = ${tomorrowISO}
- Patient was discharged recently and needs a follow-up appointment

**Business Hours (Clinic Time Zone):**
- Available slots: 9:00 AM, 11:00 AM, 2:00 PM

**Your Tool-Use Protocol:**
Use the scheduling tools to help ${patientRecord.patientName} book their follow-up appointment with Dr. ${patientRecord.doctorName}.
`;
        PROMPT_CACHE_DATE = currentDateString;
    }
    return CACHED_SCHEDULING_AGENT_PROMPT;
}

// =========================================================================================
// IMPROVEMENT 2: The Triage Agent is simplified. The "connect to nurse" route is removed.
// =========================================================================================
const TRIAGE_AGENT_PROMPT = `You are a precise internal routing agent. Analyze the user's message and respond with ONLY a routing command.

**Priority 1: Safety Override**
- If user input contains keywords of severe distress ("breathless," "dizzy," "chest pain," "can't breathe," "emergency") -> "ROUTE_TO_SAFETY"

**Priority 2: Completion Detection**
- If user indicates NO PROBLEMS, NO ISSUES, or everything is FINE/GOOD/WELL with medication -> "ROUTE_TO_SCHEDULING"
- Look for phrases: "no problems", "no issues", "fine", "good", "well", "no side effects", "everything is good", "managing well"

**Priority 3: Task-Oriented Requests**
- **User asks about medication**, prescriptions, side effects, doses, how to take medicine, pills, meds, "my medication", "medication details", "prescription", "taking", "picked up", "pharmacy" -> "ROUTE_TO_ADHERENCE"
- **User asks about appointments**, scheduling, booking, calendar, visits, rescheduling, canceling -> "ROUTE_TO_SCHEDULING"

**Priority 4: Affirmative Responses to Medication Questions**
- If user responds with "yes", "no", "I have", "I picked", "I got", "I took", "I am taking", "already", "picked up", "paid" in context of medication -> "ROUTE_TO_ADHERENCE"

**Priority 5: General Conversation / Unclear Intent**
- If the user provides a simple greeting, confirmation, or a non-specific statement, or if the intent is truly unclear -> "ROUTE_TO_FALLBACK"

Respond with ONLY the routing command. Do not add any other text.`;


class EchoBot extends ActivityHandler {
    constructor(patientRecord) { // Accept the patient record
        super();

        if (!patientRecord) {
            throw new Error("A valid patient record must be provided.");
        }

        this.patientRecord = patientRecord; // Store the patient's data

        this.activeAgent = 'triage';
        this.conversationHistory = [];
        this.schedulingPlugin = new SchedulingPlugin(this.patientRecord.patientName); // Pass patient name to plugin
        this.conversationId = null;
        this.hasSeenUser = new Set();

        // Add conversation state tracking
        this.conversationState = {
            medicationPickedUp: false,
            dosageDiscussed: false,
            adherenceCompleted: false,
            schedulingStarted: false,
            schedulingCompleted: false
        };

        console.log(`[Bot] Initialized for patient: ${this.patientRecord.patientName} (${this.patientRecord.DocumentID})`);

        this.onMessage(async (context, next) => {
            const userText = context.activity.text;
            this.conversationId = context.activity.conversation.id;

            if (!this.hasSeenUser.has(this.conversationId)) {
                this.hasSeenUser.add(this.conversationId);

                // Create a personalized welcome message
                const welcomeMessage = `Hello ${this.patientRecord.patientName}! This is an AI assistant calling on behalf of Dr. ${this.patientRecord.doctorName}. I'm here to help with your medication follow-up for your recent discharge. How are you feeling today?`;

                const formattedWelcome = this.formatSpeechResponse(welcomeMessage, 'welcome');
                await context.sendActivity(MessageFactory.text(welcomeMessage, formattedWelcome));
                this.conversationHistory.push({ role: 'assistant', content: welcomeMessage });
                await next();
                return;
            }

            if (!userText || userText.trim().length === 0) {
                await context.sendActivity("Sorry, I didn’t catch that—could you say it again?");
                await next();
                return;
            }

            try {
                // For Bot Framework calls, don't add to conversation history
                // as processMessage now handles it directly
                const response = await this.processMessage(userText);

                // Enhanced voice formatting based on current agent context
                const speechContext = this.getSpeechContextFromResponse(response);
                const formattedResponse = this.formatSpeechResponse(response, speechContext);
                await context.sendActivity(MessageFactory.text(response, formattedResponse));

            } catch (error) {
                console.error(`[Bot] Error processing message: ${error.message}`);
                const errorResponse = this.getErrorResponse(error);
                await context.sendActivity(MessageFactory.text(errorResponse, errorResponse));
            }

            await next();
        });
    }

    // =========================================================================================
    // IMPROVEMENT 3: The processMessage function is simplified to remove the nurse-connection
    //                logic and provide a clearer fallback path.
    // =========================================================================================
    async processMessage(userText) {
        // Handle special start call trigger
        if (userText === '__START_CALL__') {
            const welcomeMessage = `Hello ${this.patientRecord.patientName}! this is Jenny calling for Dr. ${this.patientRecord.doctorName} with your follow-up. Hope you're well! Have you picked up your medication yet for ${this.patientRecord.prescriptions[0].medicationName}?`;
            this.conversationHistory.push({ role: 'assistant', content: welcomeMessage });
            return welcomeMessage; // Return clean text instead of SSML
        }

        // Add user message to conversation history
        this.conversationHistory.push({ role: 'user', content: userText });

        // Update conversation state based on user response
        this.updateConversationState(userText);

        // Check conversation state to determine appropriate routing
        console.log(`[Bot] Current conversation state:`, this.conversationState);

        const route = await this.callTriageAgent(userText);
        console.log(`[Bot] Triage decision: ${route}`);

        // Handle safety override with scheduling continuation
        if (route.includes('ROUTE_TO_SAFETY')) {
            const response = EMERGENCY_SAFETY_RESPONSE + " Would you like to schedule your follow-up with Dr. " + this.patientRecord.doctorName + "?";
            this.conversationHistory.push({ role: 'assistant', content: response });
            // Mark adherence as completed so next interaction goes to scheduling
            this.conversationState.adherenceCompleted = true;
            return response;
        }

        // Determine target agent based on conversation state and triage
        let targetAgent = null;

        if (route.includes('ROUTE_TO_ADHERENCE') && !this.conversationState.adherenceCompleted) {
            targetAgent = 'adherence';
        } else if (route.includes('ROUTE_TO_SCHEDULING') ||
                  (this.conversationState.adherenceCompleted && !this.conversationState.schedulingCompleted)) {
            targetAgent = 'scheduling';
        } else if (!this.conversationState.adherenceCompleted) {
            // If adherence is not completed, default to adherence agent
            targetAgent = 'adherence';
        }

        if (targetAgent) {
            if (this.activeAgent !== targetAgent) {
                console.log(`[Bot] Switching agent from ${this.activeAgent} to ${targetAgent}.`);
                this.activeAgent = targetAgent;
            }

            let response;
            if (this.activeAgent === 'adherence') {
                response = await this.callAdherenceAgent(userText);
            } else if (this.activeAgent === 'scheduling') {
                if (!this.conversationState.schedulingStarted) {
                    this.conversationState.schedulingStarted = true;
                    response = `Great! Let’s book your follow-up with Dr. ${this.patientRecord.doctorName}. What days work for you?`;
                } else {
                    response = await this.handleSchedulingWithTools();
                }
            }

            this.conversationHistory.push({ role: 'assistant', content: response });
            return response;
        }

        // Enhanced fallback logic
        console.log('[Bot] Executing fallback logic.');

        if (this.conversationState.adherenceCompleted && !this.conversationState.schedulingStarted) {
            this.conversationState.schedulingStarted = true;
            const response = "Perfect! Now let's schedule your follow-up appointment with Dr. " + this.patientRecord.doctorName + ". What days work best for you?";
            this.conversationHistory.push({ role: 'assistant', content: response });
            return response;
        }

        const lastBotMessage = this.conversationHistory[this.conversationHistory.length - 2]?.content;
        if (lastBotMessage && lastBotMessage.includes("I want to make sure I understand")) {
            const response = "I understand you're trying to help. Let me ask directly - do you have any side effects from your medication, or would you like to schedule your follow-up appointment?";
            this.conversationHistory.push({ role: 'assistant', content: response });
            return response;
        }

        // For first-time unclear responses, be more helpful
        const response = `I want to make sure I understand you correctly. I'm calling to check on your ${this.patientRecord.prescriptions[0].medicationName} prescription. Are you taking it as prescribed, or do you have any questions about your medication?`;
        this.conversationHistory.push({ role: 'assistant', content: response });
        return response;
    }

    getErrorResponse(error) {
        if (error.message.includes('timeout')) {
            return "I'm having a little trouble connecting right now. Could you please say that again?";
        } else if (error.message.includes('authentication')) {
            return "I'm having trouble with my system connection. We may need to try again later.";
        } else {
            return "I'm sorry, I encountered a technical issue. Let's try that one more time.";
        }
    }

    async callTriageAgent(userText) {
        try {
            const lastBotMessage = this.conversationHistory[this.conversationHistory.length - 2]?.content || 'None';

            // Create enhanced context for triage decision
            const conversationContext = `
**Conversation State:**
- Medication picked up: ${this.conversationState.medicationPickedUp}
- Dosage discussed: ${this.conversationState.dosageDiscussed}
- Adherence completed: ${this.conversationState.adherenceCompleted}
- Scheduling started: ${this.conversationState.schedulingStarted}

**Last bot message:** "${lastBotMessage}"
**User message:** "${userText}"

**Routing Priority:**
1. If adherence is completed, prefer ROUTE_TO_SCHEDULING
2. If medication/adherence topics are still active, prefer ROUTE_TO_ADHERENCE
3. Use standard routing rules for new topics
`;

            const response = await this.callOpenAI(TRIAGE_AGENT_PROMPT, [{ role: 'user', content: conversationContext }], false);
            return response.content;
        } catch (error) {
            console.error('[Bot] Triage agent error:', error.message);
            throw new Error('Failed to process triage request');
        }
    }

    async callAdherenceAgent(userText) {
        try {
            // Get the patient's primary medication
            const primaryMedication = this.patientRecord.prescriptions[0];
            const medicationDetails = `${primaryMedication.medicationName} ${primaryMedication.dosage}, taken ${primaryMedication.frequency}`;

            // Create context-aware prompt based on conversation state
            let contextualPrompt = ADHERENCE_AGENT_PROMPT;

            // Add conversation state context
            if (this.conversationState.medicationPickedUp && this.conversationState.dosageDiscussed) {
                contextualPrompt += `\n\n**IMPORTANT CONVERSATION CONTEXT:**
- Patient has already confirmed they picked up their medication
- Patient has confirmed they are taking the correct dosage
- DO NOT repeat questions about picking up medication or dosage
- Focus on side effects, missed doses, or transition to scheduling
- If patient indicates no problems, transition to scheduling with: "The last thing is to schedule your follow-up appointment with Dr. ${this.patientRecord.doctorName}. Are you available to do that now?"`;
            } else if (this.conversationState.medicationPickedUp) {
                contextualPrompt += `\n\n**IMPORTANT CONVERSATION CONTEXT:**
- Patient has already confirmed they picked up their medication
- DO NOT ask about picking up medication again
- Focus on dosage and timing questions`;
            }

            // Check if user response indicates completion (no issues)
            const userResponse = userText.toLowerCase();
            // Non-severe side effect handling (headache, fever, etc.)
            if (userResponse.includes('headache') || userResponse.includes('fever')) {
                this.conversationState.adherenceCompleted = true;
                return `Thank you for sharing. I'll notify Dr. ${this.patientRecord.doctorName}'s team about your headache and fever. Now, let's schedule your follow-up appointment with Dr. ${this.patientRecord.doctorName}. Are you available to do that now?`;
            }
            if ((userResponse.includes('no') && (userResponse.includes('problem') || userResponse.includes('side effect') || userResponse.includes('issue'))) ||
                (userResponse.includes('fine') || userResponse.includes('good') || userResponse.includes('well')) ||
                (userResponse.includes('everything is good') || userResponse.includes('managing well')) ||
                (userResponse.includes('regular') && userResponse.includes('taking'))) {
                // User indicates no issues, transition to scheduling
                this.conversationState.adherenceCompleted = true;
                console.log('[Bot] Adherence completed due to no problems indicated');
                return `Perfect! It sounds like you're managing your medication well. The last thing is to schedule your follow-up appointment with Dr. ${this.patientRecord.doctorName}. Are you available to do that now?`;
            }

            // Personalize the prompt with the patient's medication details
            const personalizedAdherencePrompt = contextualPrompt
                .replace(/{treatment_name}/g, primaryMedication.medicationName)
                .replace(/{medication_details}/g, medicationDetails)
                .replace(/{Patient_Name}/g, this.patientRecord.patientName)
                .replace(/{Doctor_Name}/g, this.patientRecord.doctorName);

            const response = await this.callOpenAI(personalizedAdherencePrompt, this.conversationHistory, false);
            if (!response || !response.content) {
                throw new Error('Invalid response from adherence agent');
            }

            // Check if adherence is completed based on response content
            if (response.content.includes('schedule your follow-up appointment') ||
                response.content.includes('The last thing is to schedule')) {
                this.conversationState.adherenceCompleted = true;
                console.log('[Bot] Adherence phase completed, ready to transition to scheduling');
            }

            return response.content;
        } catch (error) {
            console.error('[Bot] Adherence agent error:', error.message);
            throw new Error('Failed to process adherence request');
        }
    }

    // Helper: Get summary of all upcoming appointments
    async getAppointmentSummary() {
        try {
            // List all appointments for today and future
            const today = new Date();
            const dateISO = today.toISOString().split('T')[0];
            const response = await this.schedulingPlugin.listAppointments(dateISO);
            if (response && Array.isArray(response) && response.length > 0) {
                let summary = "Here is your updated appointment schedule:\n";
                response.forEach((appt, idx) => {
                    summary += `${idx + 1}. ${appt.subject} at ${new Date(appt.startDateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n`;
                });
                return summary;
            }
        } catch (e) { return ""; }
        return "";
    }

    // Update conversation state based on user input
    updateConversationState(userText) {
        const lowerText = userText.toLowerCase();

        // Check for medication pickup confirmation
        if ((lowerText.includes('pick') || lowerText.includes('got') || lowerText.includes('have')) &&
            (lowerText.includes('medication') || lowerText.includes('prescription'))) {
            this.conversationState.medicationPickedUp = true;
            console.log('[Bot] State updated: medication picked up');
        }

        // Check for dosage/schedule confirmation
        if ((lowerText.includes('once') || lowerText.includes('daily') || lowerText.includes('day') ||
             lowerText.includes('regularly') || lowerText.includes('schedule') || lowerText.includes('morning') ||
             lowerText.includes('evening') || lowerText.includes('taking')) &&
            (lowerText.includes('taking') || lowerText.includes('yes') || lowerText.includes('am') ||
             lowerText.includes('every'))) {
            this.conversationState.dosageDiscussed = true;
            console.log('[Bot] State updated: dosage discussed');
        }

        // Check for "no problems/issues" responses - these should complete adherence
        if ((lowerText.includes('no') &&
             (lowerText.includes('problem') || lowerText.includes('issue') || lowerText.includes('side effect'))) ||
            (lowerText.includes('fine') || lowerText.includes('good') || lowerText.includes('well') ||
             lowerText.includes('everything is good') || lowerText.includes('managing well'))) {
            this.conversationState.adherenceCompleted = true;
            console.log('[Bot] State updated: adherence completed (no problems indicated)');
        }

        // Check for scheduling-related responses
        if (lowerText.includes('schedule') || lowerText.includes('appointment') ||
            lowerText.includes('book') || lowerText.includes('available')) {
            this.conversationState.schedulingStarted = true;
            console.log('[Bot] State updated: scheduling started');
        }
    }

    async handleSchedulingWithTools() {
        try {
            const aiResponse = await this.callOpenAI(getSchedulingAgentPrompt(this.patientRecord), this.conversationHistory, true);

            if (!aiResponse) throw new Error('Invalid response from scheduling agent');

            if (aiResponse.tool_calls) {
                const toolCall = aiResponse.tool_calls[0];
                const functionName = toolCall.function.name;
                const functionArgs = JSON.parse(toolCall.function.arguments);

                console.log(`[Bot] Tool requested: ${functionName}`);

                let toolResult = '';
                try {
                    // Dynamically call the plugin method
                    if (typeof this.schedulingPlugin[functionName] === 'function') {
                        toolResult = await this.schedulingPlugin[functionName](...Object.values(functionArgs));
                    } else {
                        throw new Error(`Unknown function: ${functionName}`);
                    }
                } catch (toolError) {
                    console.error(`[Bot] Tool execution error (${functionName}):`, toolError.message);
                    toolResult = `Error: ${toolError.message}`;
                }

                this.conversationHistory.push({ role: 'assistant', content: null, tool_calls: aiResponse.tool_calls });
                this.conversationHistory.push({ role: 'tool', tool_call_id: toolCall.id, name: functionName, content: toolResult });

                // Final call to get a natural language response
                const finalResponse = await this.callOpenAI(getSchedulingAgentPrompt(this.patientRecord), this.conversationHistory, true);

                // Appointment summary after create/reschedule/cancel
                if (['createAppointment', 'rescheduleAppointment', 'cancelAppointment'].includes(functionName)) {
                    const summary = await this.getAppointmentSummary();
                    if (finalResponse && finalResponse.content) {
                        return `${finalResponse.content}\n\n${summary}`;
                    } else if (summary) {
                        return summary;
                    }
                }

                if (!finalResponse || !finalResponse.content) {
                     // If the final LLM call fails but the tool succeeded, create a graceful fallback response.
                    if (toolResult && !toolResult.toLowerCase().includes('error') && !toolResult.toLowerCase().includes('fail')) {
                        const successMessage = "I've just processed your request. Please let me know if you need anything else!";
                        return successMessage;
                    }
                    throw new Error('No content in final AI response and tool result was an error.');
                }

                return finalResponse.content;

            } else {
                if (!aiResponse.content) throw new Error('No content in AI response');
                return aiResponse.content;
            }

        } catch (error) {
            console.error('[Bot] Scheduling error:', error.message);
            return "I apologize, I'm having trouble accessing the appointment calendar right now. Can we try again in a few moments?";
        }
    }

    // callOpenAI and other helper functions remain the same as v2.1
    async callOpenAI(systemPrompt, history, includeTools = true) {
        const messages = [{ role: 'system', content: systemPrompt }, ...history];

        const tools = includeTools ? [
            { type: 'function', function: { name: 'findAvailability', description: 'Checks for available appointment slots on a specific date (YYYY-MM-DD).', parameters: { type: 'object', properties: { date: { type: 'string', description: 'The date to check, in YYYY-MM-DD format.' } }, required: ['date'] } } },
            { type: 'function', function: { name: 'createAppointment', description: 'Books a new appointment.', parameters: { type: 'object', properties: { appointmentDateTime: { type: 'string', description: 'The appointment time in ISO 8601 format (e.g., "2025-07-15T14:00:00").' }, patientName: { type: 'string', description: "The patient's name." } }, required: ['appointmentDateTime', 'patientName'] } } },
            { type: 'function', function: { name: 'listAppointments', description: 'Lists all appointments for a specific date (YYYY-MM-DD).', parameters: { type: 'object', properties: { date: { type: 'string', description: 'The date to check, in YYYY-MM-DD format.' } }, required: ['date'] } } },
            { type: 'function', function: { name: 'cancelAppointment', description: 'Cancels an existing appointment.', parameters: { type: 'object', properties: { date: { type: 'string', description: 'The appointment date in YYYY-MM-DD format.' }, time: { type: 'string', description: 'The appointment time (e.g., "9:00 AM").' } }, required: ['date', 'time'] } } },
            { type: 'function', function: { name: 'rescheduleAppointment', description: 'Reschedules an appointment.', parameters: { type: 'object', properties: { originalDate: { type: 'string', description: 'The original appointment date (YYYY-MM-DD).' }, originalTime: { type: 'string', description: 'The original appointment time.' }, newDateTime: { type: 'string', description: 'The new appointment time in ISO 8601 format.' }, patientName: { type: 'string', description: "The patient's name." } }, required: ['originalDate', 'originalTime', 'newDateTime', 'patientName'] } } },
        ] : [];

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

        let lastError;
        for (let attempt = 0; attempt < AZURE_OPENAI_CONFIG.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), AZURE_OPENAI_CONFIG.timeoutMs);

                const response = await axios.post(
                    `${AZURE_OPENAI_CONFIG.endpoint}openai/deployments/${AZURE_OPENAI_CONFIG.deploymentName}/chat/completions?api-version=${AZURE_OPENAI_CONFIG.apiVersion}`,
                    requestBody,
                    {
                        headers: { 'api-key': AZURE_OPENAI_CONFIG.apiKey, 'Content-Type': 'application/json' },
                        signal: controller.signal
                    }
                );
                clearTimeout(timeoutId);

                if (!response.data?.choices?.[0]?.message) {
                    throw new Error('Invalid response structure from Azure OpenAI');
                }

                console.log(`[Bot] Azure OpenAI call successful (attempt ${attempt + 1})`);
                return response.data.choices[0].message;

            } catch (error) {
                lastError = error;
                console.error(`[Bot] Azure OpenAI API error (attempt ${attempt + 1}):`, error.message);

                if (this.isRetryableError(error)) {
                    if (attempt < AZURE_OPENAI_CONFIG.maxRetries - 1) {
                        const delay = AZURE_OPENAI_CONFIG.retryDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
                        console.log(`[Bot] Retrying in ${delay.toFixed(0)}ms...`);
                        await this.sleep(delay);
                        continue;
                    }
                }
                break;
            }
        }

        console.error('[Bot] Azure OpenAI API failed after all retries.');
        if (lastError.response?.status === 429) throw new Error('rate limit');
        if (lastError.response?.status === 401) throw new Error('authentication');
        if (lastError.name === 'AbortError') throw new Error('timeout');
        throw new Error('API error');
    }

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

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Determine appropriate speech context based on response content and active agent
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

    // Enhanced speech formatting for better TTS quality
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

    // Save patient call data and update the JSON file
    async savePatientCallData(adherenceData = null, appointmentData = null) {
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
                console.log(`[Bot] Updated patient data for ${this.patientRecord.patientName}`);
            }
        } catch (error) {
            console.error('[Bot] Error saving patient call data:', error.message);
        }
    }
}

module.exports.EchoBot = EchoBot;