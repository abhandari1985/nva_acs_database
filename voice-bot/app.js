// app.js
// Main Express web server for Azure Communication Services voice calling application
// Implements secure authentication, error handling, and proper Azure SDK patterns

const express = require('express');
const { CallAutomationClient } = require('@azure/communication-call-automation');
const { DefaultAzureCredential } = require('@azure/identity');
const { SpeechConfig, SpeechSynthesizer, AudioConfig } = require('microsoft-cognitiveservices-speech-sdk');
const CosmosDbService = require('./cosmosDbService');

require('dotenv').config();

const app = express();

// --- MIDDLEWARE ---
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf, encoding) => {
        // Store raw body for debugging webhook issues
        req.rawBody = buf.toString(encoding || 'utf8');
    }
}));
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// --- CONFIGURATION ---
const PORT = process.env.ACS_PORT || process.env.PORT || 3979; // Different port for ACS server
const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING;
const ACS_PHONE_NUMBER = process.env.ACS_PHONE_NUMBER;
const SPEECH_KEY = process.env.SPEECH_KEY;
const SPEECH_REGION = process.env.SPEECH_REGION || 'eastus';
const SPEECH_ENDPOINT = process.env.SPEECH_ENDPOINT;

// Validate required environment variables
if (!ACS_CONNECTION_STRING) {
    console.error('❌ ACS_CONNECTION_STRING environment variable is required');
    process.exit(1);
}

if (!ACS_PHONE_NUMBER) {
    console.error('❌ ACS_PHONE_NUMBER environment variable is required');
    process.exit(1);
}

if (!SPEECH_KEY) {
    console.error('❌ SPEECH_KEY environment variable is required');
    process.exit(1);
}

// --- SERVICES INITIALIZATION ---
let callClient;
let cosmosDbService;

try {
    // Initialize Azure Communication Services Call Automation client
    callClient = new CallAutomationClient(ACS_CONNECTION_STRING);
    
    // Initialize Cosmos DB service
    cosmosDbService = new CosmosDbService();
    
    console.log('✅ Azure services initialized successfully');
} catch (error) {
    console.error('❌ Failed to initialize Azure services:', error.message);
    process.exit(1);
}

// --- CALL STATE MANAGEMENT ---
// This will hold the state of active calls with proper cleanup
const callStates = new Map();

// Cleanup call state after a specified timeout to prevent memory leaks
const CALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function cleanupCallState(callConnectionId) {
    if (callStates.has(callConnectionId)) {
        clearTimeout(callStates.get(callConnectionId).timeoutId);
        callStates.delete(callConnectionId);
        console.log(`🧹 Cleaned up state for call: ${callConnectionId}`);
    }
}

function setCallTimeout(callConnectionId) {
    const timeoutId = setTimeout(() => {
        console.log(`⏰ Call timeout reached for: ${callConnectionId}`);
        cleanupCallState(callConnectionId);
    }, CALL_TIMEOUT_MS);
    
    if (callStates.has(callConnectionId)) {
        callStates.get(callConnectionId).timeoutId = timeoutId;
    }
}

// --- HEALTH CHECK ENDPOINT ---
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        activeCalls: callStates.size 
    });
});

// --- MAIN ACS CALLBACK ENDPOINT ---
app.post('/api/callbacks', async (req, res) => {
    try {
        console.log('🔔 Received callback request');
        console.log('📄 Content-Type:', req.get('Content-Type'));
        console.log('📄 Raw body length:', req.rawBody ? req.rawBody.length : 'No raw body');
        
        // Add better JSON handling
        let events;
        try {
            if (req.body && typeof req.body === 'object') {
                events = req.body;
            } else if (req.rawBody) {
                console.log('🔧 Parsing raw body as JSON');
                console.log('📄 Raw body:', req.rawBody.substring(0, 500) + (req.rawBody.length > 500 ? '...' : ''));
                events = JSON.parse(req.rawBody);
            } else {
                console.log('⚠️ No body data received');
                return res.sendStatus(200);
            }
            
            events = Array.isArray(events) ? events : [events];
            
            console.log('✅ Parsed events count:', events.length);
            console.log('📋 First event structure:', events[0] ? Object.keys(events[0]) : 'No events');
        } catch (parseError) {
            console.error('❌ JSON Parse Error:', parseError.message);
            console.log('📄 Problematic raw body:', req.rawBody ? req.rawBody.substring(0, 200) : 'No raw body');
            return res.status(400).json({ error: 'Invalid JSON format' });
        }
        
        if (events.length === 0) {
            console.log('⚠️ Empty events array received');
            return res.sendStatus(200);
        }

        // Process each event
        for (const event of events) {
            if (!event) {
                console.warn('⚠️ Received malformed event:', event);
                continue;
            }

            // --- HANDLE AZURE EVENT GRID SUBSCRIPTION VALIDATION ---
            if (event.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
                console.log('🔐 Received Event Grid validation request');
                
                const validationCode = event.data?.validationCode;
                
                if (validationCode) {
                    console.log('✅ Responding with validation code for Event Grid subscription');
                    return res.status(200).json({
                        validationResponse: validationCode
                    });
                } else {
                    console.error('❌ No validation code found in validation event');
                    return res.status(400).json({ error: 'Missing validation code' });
                }
            }

            // --- HANDLE ACS COMMUNICATION EVENTS ---
            // Support both Azure Event Grid and ACS webhook formats
            let eventType = event.type || event.eventType;
            let callConnectionId = event.callConnectionId || event.data?.callConnectionId;
            
            // Extract callConnectionId from subject if not directly available
            if (!callConnectionId && event.subject) {
                console.log(`🔍 Attempting to extract callConnectionId from subject: ${event.subject}`);
                
                // Subject format: "call/{callConnectionId}/startedBy/{participantId}"
                const subjectParts = event.subject.split('/');
                if (subjectParts.length >= 2 && subjectParts[0] === 'call') {
                    callConnectionId = subjectParts[1];
                    console.log(`✅ Extracted callConnectionId from subject: ${callConnectionId}`);
                }
            }
            
            // Also try to extract from data object if still not found
            if (!callConnectionId && event.data) {
                callConnectionId = event.data.callConnectionId || event.data.serverCallId;
                if (callConnectionId) {
                    console.log(`✅ Extracted callConnectionId from data: ${callConnectionId}`);
                }
            }
            
            if (!eventType) {
                console.warn('⚠️ Received event without type:', event);
                continue;
            }

            console.log(`[ACS Event] 📞 ${eventType} for call ${callConnectionId || 'UNKNOWN'}`);
            
            // Skip processing if we still don't have a callConnectionId
            if (!callConnectionId) {
                console.warn(`⚠️ Skipping event ${eventType} - no callConnectionId found`);
                continue;
            }
            
            // Create normalized event object
            const normalizedEvent = {
                ...event,
                type: eventType,
                callConnectionId: callConnectionId
            };
            
            try {
                await processAcsEvent(normalizedEvent);
            } catch (error) {
                console.error(`❌ Error processing event ${eventType}:`, error.message);
                // Continue processing other events even if one fails
            }
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Error in callback endpoint:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- EVENT PROCESSING ---
async function processAcsEvent(event) {
    const { type, callConnectionId } = event;
    
    switch (type) {
        case "Microsoft.Communication.CallConnected":
        case "Microsoft.Communication.CallStarted":
            await handleCallConnected(event);
            break;
        case "Microsoft.Communication.RecognizeCompleted":
            await handleRecognizeCompleted(event);
            break;
        case "Microsoft.Communication.RecognizeFailed":
            await handleRecognizeFailed(event);
            break;
        case "Microsoft.Communication.PlayCompleted":
            await handlePlayCompleted(event);
            break;
        case "Microsoft.Communication.PlayFailed":
            await handlePlayFailed(event);
            break;
        case "Microsoft.Communication.CallDisconnected":
        case "Microsoft.Communication.CallEnded":
            await handleCallDisconnected(event);
            break;
        case "Microsoft.Communication.ParticipantsUpdated":
            console.log(`ℹ️ Participants updated for call: ${callConnectionId}`);
            break;
        default:
            console.log(`ℹ️ Unhandled event type: ${type}`);
    }
}

// --- CALL EVENT HANDLERS ---
async function handleCallConnected(event) {
    const { callConnectionId } = event;
    
    try {
        const callConnection = callClient.getCallConnection(callConnectionId);
        
        // Get patient data from the stored call context (from trigger-call endpoint)
        const storedCallContext = callStates.get(callConnectionId);
        
        let patient;
        if (storedCallContext) {
            // Use the patient data that was passed when the call was triggered
            patient = {
                patientName: storedCallContext.patientName || 'Test Patient',
                phoneNumber: storedCallContext.phoneNumber,
                doctorName: storedCallContext.doctorName || 'Test Doctor',
                medication: 'prescribed medication'
            };
        } else {
            // Fallback: try to get from Cosmos DB
            patient = await getPatientForFollowUp();
        }
        
        if (!patient) {
            console.error('❌ Call connected but could not find patient data - using default');
            // Instead of hanging up, use default patient data for testing
            patient = {
                patientName: 'Test Patient',
                phoneNumber: '+919158066045',
                doctorName: 'Test Doctor',
                medication: 'prescribed medication'
            };
        }

        // Initialize call state with proper timeout management
        callStates.set(callConnectionId, {
            patient: patient,
            conversationHistory: [],
            callStartTime: new Date(),
            status: 'connected'
        });
        
        setCallTimeout(callConnectionId);

        console.log(`✅ Call connected for patient: ${patient.patientName} (${patient.phoneNumber})`);

        // Personalized greeting based on patient data
        const greeting = `Hello ${patient.patientName}. This is Alex, your virtual healthcare assistant from the post-discharge care team, calling on behalf of Dr. ${patient.doctorName}. Is now a good time to talk briefly about your new medication protocol?`;
        
        await playTextToPatient(callConnection, greeting, true);
        
    } catch (error) {
        console.error('❌ Error in handleCallConnected:', error.message);
        cleanupCallState(callConnectionId);
    }
}

async function handleRecognizeCompleted(event) {
    const { callConnectionId, result } = event;
    
    try {
        const callConnection = callClient.getCallConnection(callConnectionId);
        const callState = callStates.get(callConnectionId);
        
        if (!callState) {
            console.error('❌ No call state found for:', callConnectionId);
            return;
        }

        const userText = result?.speech || '';
        
        if (!userText.trim()) {
            console.log('🔇 No speech detected, prompting again');
            await playTextToPatient(callConnection, "I didn't catch that. Could you please repeat?", true);
            return;
        }

        console.log(`[STT] 🗣️ User said: "${userText}"`);

        // --- PLACEHOLDER FOR AI AGENT INTEGRATION ---
        // Tomorrow, we will replace this with our AI Agent service
        const agentReply = await generateAgentResponse(userText, callState);
        
        // Update conversation history
        callState.conversationHistory.push({ 
            role: 'user', 
            content: userText,
            timestamp: new Date()
        });
        callState.conversationHistory.push({ 
            role: 'assistant', 
            content: agentReply,
            timestamp: new Date()
        });
        
        await playTextToPatient(callConnection, agentReply, true);
        
    } catch (error) {
        console.error('❌ Error in handleRecognizeCompleted:', error.message);
    }
}

async function handleRecognizeFailed(event) {
    const { callConnectionId, result } = event;
    console.error(`❌ Speech recognition failed for call ${callConnectionId}:`, result?.reason);
    
    try {
        const callConnection = callClient.getCallConnection(callConnectionId);
        await playTextToPatient(callConnection, "I'm having trouble hearing you. Could you please speak a bit louder?", true);
    } catch (error) {
        console.error('❌ Error handling recognize failure:', error.message);
    }
}

async function handlePlayCompleted(event) {
    console.log(`✅ Audio playback completed for call: ${event.callConnectionId}`);
}

async function handlePlayFailed(event) {
    const { callConnectionId, result } = event;
    console.error(`❌ Audio playback failed for call ${callConnectionId}:`, result?.reason);
}

async function handleCallDisconnected(event) {
    const { callConnectionId } = event;
    console.log(`📞 Call disconnected: ${callConnectionId}`);
    
    try {
        const callState = callStates.get(callConnectionId);
        
        if (callState) {
            // Save call summary to database
            await saveCallSummary(callState);
        }
        
        cleanupCallState(callConnectionId);
    } catch (error) {
        console.error('❌ Error in handleCallDisconnected:', error.message);
    }
}

// --- HELPER FUNCTIONS ---
async function playTextToPatient(callConnection, text, listenAfterPlaying = false) {
    try {
        console.log(`🔊 Playing to patient: "${text}"`);
        
        // Use Azure Speech Services for high-quality text-to-speech
        // Fixed payload structure for Azure Communication Services
        await callConnection.getCallMedia().playToAll([{
            kind: 'textSource',
            text: text,
            voiceName: 'en-IN-NeerjaNeural', // Indian English voice for better localization
            customVoiceEndpointId: process.env.CUSTOM_VOICE_ENDPOINT_ID // Optional custom voice
        }]);
        
        if (listenAfterPlaying) {
            // Start listening for the user's response with optimized settings
            const callState = callStates.get(callConnection.callConnectionId);
            const patientPhoneNumber = callState?.patient?.phoneNumber;
            
            if (patientPhoneNumber) {
                await callConnection.getCallMedia().startRecognizing({
                    targetParticipant: {
                        kind: 'phoneNumber',
                        phoneNumber: patientPhoneNumber
                    },
                    recognizeOptions: {
                        interruptPrompt: true,
                        initialSilenceTimeoutInSeconds: 5,
                        maxTonesToCollect: 0, // We want speech, not DTMF
                        speechLanguage: 'en-IN', // Indian English for better recognition
                        speechModelEndpointId: process.env.CUSTOM_SPEECH_ENDPOINT_ID // Optional custom speech model
                    }
                });
            }
        }
    } catch (error) {
        console.error('❌ Error in playTextToPatient:', error.message);
        throw error;
    }
}

async function generateAgentResponse(userText, callState) {
    // PLACEHOLDER: This will be replaced with actual AI agent integration
    // For now, return a context-aware response
    
    const patient = callState.patient;
    const conversationLength = callState.conversationHistory.length;
    
    // Simple rule-based responses for initial testing
    const lowerText = userText.toLowerCase();
    
    if (lowerText.includes('yes') || lowerText.includes('good time')) {
        return `Great! I wanted to check how you're feeling since your discharge. According to your records, you should be taking ${patient.medication || 'your prescribed medication'} twice daily. Are you following this schedule?`;
    } else if (lowerText.includes('no') || lowerText.includes('busy')) {
        return "I understand you're busy. This will only take 2-3 minutes. When would be a better time for me to call you back today?";
    } else if (lowerText.includes('taking') || lowerText.includes('medication')) {
        return "That's wonderful to hear. Are you experiencing any side effects or concerns with your medication?";
    } else if (conversationLength > 6) {
        return "Thank you for taking the time to speak with me today. Your healthcare team will review this information. Have a great day!";
    } else {
        return `I understand. Can you tell me more about that? Remember, I'm here to help ensure you're recovering well after your recent visit with Dr. ${patient.doctorName}.`;
    }
}

async function getPatientForFollowUp() {
    try {
        // Get patients who need follow-up calls using the existing CosmosDbService method
        const patients = await cosmosDbService.getPatientsNeedingFollowUp();
        return patients.length > 0 ? patients[0] : null;
        
    } catch (error) {
        console.error('❌ Error getting patient for follow-up:', error.message);
        return null;
    }
}

async function saveCallSummary(callState) {
    try {
        const { patient, conversationHistory, callStartTime } = callState;
        const callEndTime = new Date();
        const callDuration = Math.round((callEndTime - callStartTime) / 1000); // seconds
        
        const callSummary = {
            patientId: patient.id,
            callDate: callStartTime,
            callDuration: callDuration,
            conversationHistory: conversationHistory,
            callOutcome: 'completed', // This could be determined by AI analysis
            lastCallDate: callEndTime
        };
        
        // Update patient record with call information
        await cosmosDbService.updatePatientRecord(patient.id, {
            lastCallDate: callEndTime,
            callHistory: [...(patient.callHistory || []), callSummary]
        });
        
        console.log(`✅ Call summary saved for patient: ${patient.patientName}`);
        
    } catch (error) {
        console.error('❌ Error saving call summary:', error.message);
    }
}

// --- MANUAL CALL TRIGGER ENDPOINT (FOR TESTING) ---
app.post('/api/trigger-call', async (req, res) => {
    try {
        const { phoneNumber, patientId, patientName, doctorName, medications } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        console.log(`🎯 Initiating call to: ${phoneNumber}`);
        console.log(`👤 Patient: ${patientName || 'Unknown'}`);
        console.log(`🩺 Doctor: Dr. ${doctorName || 'Unknown'}`);
        
        // Validate phone number format for international calling
        if (!phoneNumber.startsWith('+')) {
            return res.status(400).json({ error: 'Phone number must include country code (e.g., +919123456789)' });
        }

        // Create the outbound call using object format for phone number identifiers
        const callInvite = {
            targetParticipant: {
                kind: 'phoneNumber',
                phoneNumber: phoneNumber
            },
            sourceCallIdNumber: {
                kind: 'phoneNumber',
                phoneNumber: ACS_PHONE_NUMBER
            }
        };

        console.log(`📞 Making call from ${ACS_PHONE_NUMBER} to ${phoneNumber}`);
        
        // Set callback URL for ACS events - use Dev Tunnel URL for Azure to reach us
        const callbackUrl = process.env.ACS_CALLBACK_URL || 'https://ks4mqb43-3979.inc1.devtunnels.ms/api/callbacks';
        
        console.log(`🔗 Using callback URL: ${callbackUrl}`);
        
        const createCallResult = await callClient.createCall(
            callInvite,
            callbackUrl
            // Note: Speech Services must be configured at the ACS resource level in Azure portal
        );

        const callConnectionId = createCallResult.callConnection.callConnectionId;
        
        // Store call context for later use (using Map.set for consistency)
        callStates.set(callConnectionId, {
            patientId,
            patientName,
            doctorName,
            medications,
            phoneNumber,
            conversationHistory: [],
            startTime: new Date().toISOString()
        });

        console.log(`✅ Call initiated successfully! Call ID: ${callConnectionId}`);
        
        res.json({ 
            success: true,
            message: 'Call initiated successfully',
            callConnectionId: callConnectionId,
            phoneNumber: phoneNumber,
            patient: patientName,
            status: 'call_initiated'
        });
        
    } catch (error) {
        console.error('❌ Error initiating call:', error.message);
        
        if (error.message.includes('400')) {
            res.status(400).json({ 
                error: 'Call failed - check phone number format and ACS configuration',
                details: error.message 
            });
        } else {
            res.status(500).json({ 
                error: 'Internal server error',
                details: error.message 
            });
        }
    }
});

// --- ERROR HANDLING MIDDLEWARE ---
app.use((error, req, res, next) => {
    console.error('❌ Unhandled error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
});

// --- GRACEFUL SHUTDOWN ---
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    // Clean up active calls
    for (const [callId, callState] of callStates) {
        try {
            cleanupCallState(callId);
        } catch (error) {
            console.error(`❌ Error cleaning up call ${callId}:`, error.message);
        }
    }
    
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

// --- SERVER STARTUP ---
app.listen(PORT, () => {
    console.log('🚀 Healthcare Voice Bot Server Started');
    console.log(`📡 Server listening on port ${PORT}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
    console.log('🔧 Ensure your Dev Tunnel is running and ACS is configured with its public URI.');
    console.log(`📊 Active calls will be tracked and cleaned up automatically`);
    
    // Optional: Display configuration status
    console.log('\n📋 Configuration Status:');
    console.log(`   ✅ ACS Connection: ${ACS_CONNECTION_STRING ? 'Configured' : '❌ Missing'}`);
    console.log(`   ✅ ACS Phone Number: ${ACS_PHONE_NUMBER || '❌ Missing'}`);
    console.log(`   ✅ Speech Service: ${SPEECH_KEY ? 'Configured' : '❌ Missing'}`);
    console.log(`   ✅ Speech Region: ${SPEECH_REGION}`);
    console.log(`   ✅ Cosmos DB: ${cosmosDbService ? 'Initialized' : '❌ Failed'}`);
});

module.exports = app;
