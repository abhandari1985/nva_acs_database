// app.js
// Main Express web server for Azure Communication Services voice calling application
// Implements secure authentication, error handling, and proper Azure SDK patterns

const express = require('express');
// Global error handlers for better debugging
process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error.message);
    console.error('Stack trace:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
});

// Enhanced logging for startup
console.log('🚀 Voice Bot Server Starting...');
console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`🔗 ACS Connection String: ${process.env.AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING ? 'Configured' : 'MISSING'}`);
console.log(`🗄️ CosmosDB Endpoint: ${process.env.COSMOSDB_ENDPOINT ? 'Configured' : 'MISSING'}`);
console.log(`🎤 Speech Services Key: ${process.env.AZURE_SPEECH_SERVICES_KEY ? 'Configured' : 'MISSING'}`);

const { CallAutomationClient } = require('@azure/communication-call-automation');
const { DefaultAzureCredential } = require('@azure/identity');
const { SpeechConfig, SpeechSynthesizer, AudioConfig } = require('microsoft-cognitiveservices-speech-sdk');
const CosmosDbService = require('./cosmosDbService');
const { PatientBot } = require('./patientBot');

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
    console.log('🔍 Request Headers:', JSON.stringify(req.headers, null, 2));
    next();
});

// --- CONFIGURATION ---
const PORT = process.env.ACS_PORT || process.env.PORT || 3979; // Different port for ACS server
const ACS_CONNECTION_STRING = process.env.ACS_CONNECTION_STRING;
const ACS_PHONE_NUMBER = process.env.ACS_PHONE_NUMBER;
const SPEECH_KEY = process.env.SPEECH_KEY;
const SPEECH_REGION = process.env.SPEECH_REGION || 'eastus2';
const SPEECH_ENDPOINT = process.env.SPEECH_ENDPOINT || `https://${SPEECH_REGION}.cognitiveservices.azure.com/`;

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
    // Initialize Azure Communication Services Call Automation client with cognitive services configuration
    const callAutomationOptions = {
        cognitiveServicesEndpoint: SPEECH_ENDPOINT
    };
    
    console.log(`🎤 Using Speech Endpoint: ${SPEECH_ENDPOINT}`);
    console.log(`🎤 Using Speech Region: ${SPEECH_REGION}`);
    
    callClient = new CallAutomationClient(ACS_CONNECTION_STRING, callAutomationOptions);
    
    // Initialize Cosmos DB service
    cosmosDbService = new CosmosDbService();
    
    console.log('✅ Azure services initialized successfully');
    console.log(`🎤 Cognitive Services Endpoint: ${callAutomationOptions.cognitiveServicesEndpoint}`);
    console.log(`🎤 Speech Region: ${SPEECH_REGION}`);
} catch (error) {
    console.error('❌ Failed to initialize Azure services:', error.message);
    process.exit(1);
}

// --- CALL STATE MANAGEMENT ---
// This will hold the state of active calls with proper cleanup
const callStates = new Map();

// Map to track call ID relationships (both Event Grid and Direct ACS webhook IDs)
const callIdMapping = new Map();

// Cleanup call state after a specified timeout to prevent memory leaks
const CALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Normalize call connection IDs to handle both Event Grid and direct ACS webhook formats
 * ACS sometimes sends different call IDs for the same call in different event sources
 */
function normalizeCallConnectionId(callId) {
    if (!callId) return null;
    
    // Check if we've seen this ID before and have a mapping
    if (callIdMapping.has(callId)) {
        const normalizedId = callIdMapping.get(callId);
        console.log(`🔗 Using mapped call ID: ${callId} -> ${normalizedId}`);
        return normalizedId;
    }
    
    // For new IDs, check if it might be an encoded version
    if (callId.length > 50 && callId.includes('aHR0')) {
        // This looks like a base64 encoded URL, try to find a simpler ID
        for (const [existingId, normalizedId] of callIdMapping.entries()) {
            if (existingId.length < 50) {
                // Map the long ID to the shorter one
                callIdMapping.set(callId, normalizedId);
                console.log(`🔗 Created call ID mapping: ${callId.substring(0, 30)}... -> ${normalizedId}`);
                return normalizedId;
            }
        }
    }
    
    // For shorter IDs, check if we have a longer version already mapped
    if (callId.length < 50) {
        for (const [existingId, normalizedId] of callIdMapping.entries()) {
            if (normalizedId === callId) {
                // This ID is already the normalized version
                return callId;
            }
        }
        
        // This is a new short ID, use it as the normalized version
        callIdMapping.set(callId, callId);
        return callId;
    }
    
    // If no mapping exists, create one using this ID as the normalized version
    callIdMapping.set(callId, callId);
    return callId;
}

// Enhanced call state structure
function createCallState(patient, patientBot) {
    return {
        patient: patient,
        patientBot: patientBot,
        conversationHistory: [],
        callStartTime: new Date(),
        status: 'initializing',
        // Event tracking for better synchronization
        events: {
            callConnected: false,
            callStarted: false,
            participantAdded: false,
            greetingPlayed: false
        },
        participants: new Set(),
        timeoutId: null
    };
}

function cleanupCallState(callConnectionId) {
    // Handle cleanup for both the normalized ID and any mapped IDs
    const normalizedId = normalizeCallConnectionId(callConnectionId);
    
    if (callStates.has(normalizedId)) {
        clearTimeout(callStates.get(normalizedId).timeoutId);
        callStates.delete(normalizedId);
        console.log(`🧹 Cleaned up state for call: ${normalizedId}`);
    }
    
    // Also cleanup the original ID if different
    if (callConnectionId !== normalizedId && callStates.has(callConnectionId)) {
        clearTimeout(callStates.get(callConnectionId).timeoutId);
        callStates.delete(callConnectionId);
        console.log(`🧹 Cleaned up state for original call ID: ${callConnectionId}`);
    }
    
    // Clean up call ID mappings
    for (const [key, value] of callIdMapping.entries()) {
        if (key === callConnectionId || value === callConnectionId || 
            key === normalizedId || value === normalizedId) {
            callIdMapping.delete(key);
        }
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

/**
 * Initialize PatientBot with enhanced error handling and validation
 * @param {Object} patient - Patient record data
 * @param {Object} cosmosDbService - Cosmos DB service instance
 * @returns {Object|null} - PatientBot instance or null if initialization fails
 */
function initializePatientBot(patient, cosmosDbService) {
    try {
        // Validate patient data before creating PatientBot
        if (!patient || !patient.patientName) {
            console.error('❌ Invalid patient data for PatientBot initialization');
            return null;
        }
        
        // Ensure patient data has required fields for PatientBot
        const patientData = {
            patientName: patient.patientName,
            doctorName: patient.doctorName || 'Doctor',
            DocumentID: patient.DocumentID || `temp-${Date.now()}`,
            prescriptions: patient.prescriptions || [{
                medicationName: patient.primaryMedication || 'prescribed medication',
                dosage: patient.dosage || '10mg',
                frequency: patient.frequency || 'once daily'
            }],
            primaryMedication: patient.primaryMedication || patient.prescriptions?.[0]?.medicationName || 'prescribed medication'
        };
        
        const patientBot = new PatientBot(patientData, cosmosDbService);
        console.log(`✅ PatientBot initialized successfully for ${patient.patientName}`);
        return patientBot;
        
    } catch (error) {
        console.error('❌ Error initializing PatientBot:', error.message);
        console.error('📊 Patient data:', JSON.stringify(patient, null, 2));
        return null;
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

// --- CONVERSATION MONITORING DASHBOARD ---
app.get('/api/conversation-status', (req, res) => {
    try {
        console.log('📊 Conversation status requested');
        
        const activeConversations = [];
        const callSummary = {
            totalActiveCalls: callStates.size,
            conversationsInProgress: 0,
            triageCompleted: 0,
            adherenceCompleted: 0,
            schedulingCompleted: 0,
            callsCompleted: 0
        };
        
        // Analyze each active call state
        for (const [callId, callState] of callStates.entries()) {
            const conversationState = callState.patientBot?.getConversationState();
            
            const callInfo = {
                callId: callId,
                patientId: callState.patientId,
                patientName: callState.patientName,
                startTime: callState.startTime,
                duration: callState.startTime ? Math.floor((Date.now() - callState.startTime.getTime()) / 1000) : 0,
                conversationHistory: callState.conversationHistory?.length || 0,
                currentState: conversationState ? {
                    activeAgent: conversationState.activeAgent,
                    triageCompleted: conversationState.triageCompleted,
                    adherenceCompleted: conversationState.adherenceCompleted,
                    schedulingCompleted: conversationState.schedulingCompleted,
                    callCompleted: conversationState.callCompleted
                } : null,
                lastActivity: callState.conversationHistory?.length > 0 ? 
                    callState.conversationHistory[callState.conversationHistory.length - 1].timestamp : 
                    callState.startTime
            };
            
            activeConversations.push(callInfo);
            
            // Update summary stats
            if (conversationState) {
                callSummary.conversationsInProgress++;
                if (conversationState.triageCompleted) callSummary.triageCompleted++;
                if (conversationState.adherenceCompleted) callSummary.adherenceCompleted++;
                if (conversationState.schedulingCompleted) callSummary.schedulingCompleted++;
                if (conversationState.callCompleted) callSummary.callsCompleted++;
            }
        }
        
        res.json({
            summary: callSummary,
            activeConversations: activeConversations,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Error getting conversation status:', error.message);
        res.status(500).json({ 
            error: 'Failed to get conversation status',
            timestamp: new Date().toISOString() 
        });
    }
});

// --- DETAILED CALL ANALYSIS ---
app.get('/api/call-details/:callId', (req, res) => {
    try {
        const callId = req.params.callId;
        const callState = callStates.get(callId);
        
        if (!callState) {
            return res.status(404).json({ 
                error: 'Call not found',
                callId: callId,
                timestamp: new Date().toISOString()
            });
        }
        
        const conversationState = callState.patientBot?.getConversationState();
        
        const detailedInfo = {
            callId: callId,
            patientInfo: {
                id: callState.patientId,
                name: callState.patientName,
                phoneNumber: callState.phoneNumber
            },
            callDetails: {
                startTime: callState.startTime,
                duration: callState.startTime ? Math.floor((Date.now() - callState.startTime.getTime()) / 1000) : 0,
                status: conversationState?.callCompleted ? 'completed' : 'active'
            },
            conversationState: conversationState,
            conversationHistory: callState.conversationHistory || [],
            metrics: {
                totalExchanges: Math.floor((callState.conversationHistory?.length || 0) / 2),
                averageResponseTime: 'N/A', // Could be calculated if we track timing
                speechRecognitionAttempts: callState.speechRecognitionAttempts || 0,
                fallbackResponsesUsed: callState.fallbackResponsesUsed || 0
            },
            lastActivity: callState.conversationHistory?.length > 0 ? 
                callState.conversationHistory[callState.conversationHistory.length - 1].timestamp : 
                callState.startTime
        };
        
        res.json({
            callDetails: detailedInfo,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Error getting call details:', error.message);
        res.status(500).json({ 
            error: 'Failed to get call details',
            callId: req.params.callId,
            timestamp: new Date().toISOString() 
        });
    }
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
            
            // IMPORTANT: Normalize call connection IDs to handle both formats
            // ACS sometimes sends different IDs for the same call in different events
            const normalizedCallId = normalizeCallConnectionId(callConnectionId);
            
            if (!eventType) {
                console.warn('⚠️ Received event without type:', event);
                continue;
            }

            console.log(`[ACS Event] 📞 ${eventType} for call ${normalizedCallId || 'UNKNOWN'}`);
            
            // Skip processing if we still don't have a callConnectionId
            if (!normalizedCallId) {
                console.warn(`⚠️ Skipping event ${eventType} - no callConnectionId found`);
                continue;
            }
            
            // Create normalized event object
            const normalizedEvent = {
                ...event,
                type: eventType,
                callConnectionId: normalizedCallId,
                originalCallConnectionId: callConnectionId // Keep original for debugging
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
            await handleCallConnected(event);
            break;
        case "Microsoft.Communication.CallStarted":
            await handleCallStarted(event);
            break;
        case "Microsoft.Communication.CallParticipantAdded":
            await handleCallParticipantAdded(event);
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
        case "Microsoft.Communication.PlayStarted":
            await handlePlayStarted(event);
            break;
        case "Microsoft.Communication.CallDisconnected":
        case "Microsoft.Communication.CallEnded":
            await handleCallDisconnected(event);
            break;
        case "Microsoft.Communication.ParticipantsUpdated":
            await handleParticipantsUpdated(event);
            break;
        default:
            console.log(`ℹ️ Unhandled event type: ${type}`);
    }
}

// --- CALL EVENT HANDLERS ---
async function handleCallConnected(event) {
    const { callConnectionId, originalCallConnectionId } = event;
    
    try {
        console.log(`📞 Call connected event for: ${callConnectionId}`);
        if (originalCallConnectionId && originalCallConnectionId !== callConnectionId) {
            console.log(`🔗 Original call ID: ${originalCallConnectionId}`);
        }
        
        // Create or update call ID mapping for future events
        if (originalCallConnectionId && originalCallConnectionId !== callConnectionId) {
            callIdMapping.set(originalCallConnectionId, callConnectionId);
            callIdMapping.set(callConnectionId, callConnectionId);
        }
        
        // CRITICAL: Get the existing state and ensure we use the SAME reference
        let existingCallState = callStates.get(callConnectionId);
        
        // Also check if there's context stored under the original ID
        if (!existingCallState && originalCallConnectionId) {
            existingCallState = callStates.get(originalCallConnectionId);
            if (existingCallState) {
                // Move the state to the normalized ID
                callStates.delete(originalCallConnectionId);
                callStates.set(callConnectionId, existingCallState);
                console.log(`🔄 Moved call state from ${originalCallConnectionId} to ${callConnectionId}`);
            }
        }
        
        // Get patient data from the stored call context (from trigger-call endpoint)
        let storedCallContext = existingCallState;
        
        let patient;
        if (storedCallContext && storedCallContext.patientName) {
            // Use the patient data that was passed when the call was triggered
            patient = {
                patientName: storedCallContext.patientName || 'Test Patient',
                phoneNumber: storedCallContext.phoneNumber,
                doctorName: storedCallContext.doctorName || 'Test Doctor',
                primaryMedication: 'prescribed medication',
                prescriptions: [{
                    medicationName: storedCallContext.medication || 'prescribed medication',
                    dosage: '10mg',
                    frequency: 'once daily'
                }],
                DocumentID: storedCallContext.patientId || 'test-001'
            };
        } else {
            // Fallback: try to get from Cosmos DB
            patient = await getPatientForFollowUp();
        }
        
        if (!patient) {
            console.error('❌ Call connected but could not find patient data - using default');
            patient = {
                patientName: 'Test Patient',
                phoneNumber: '+918856866045',
                doctorName: 'Test Doctor',
                primaryMedication: 'prescribed medication',
                prescriptions: [{
                    medicationName: 'prescribed medication',
                    dosage: '10mg',
                    frequency: 'once daily'
                }],
                DocumentID: 'test-default-001'
            };
        }

        // Create PatientBot instance for this specific call
        const patientBot = initializePatientBot(patient, cosmosDbService);
        
        // CRITICAL: Always use getOrCreateCallState to ensure we work with the same state object
        const callState = getOrCreateCallState(callConnectionId, 'CallConnected');
        
        if (!callState) {
            console.error('❌ Failed to get or create call state, aborting handleCallConnected');
            return;
        }
        
        if (!callState.events) {
            console.error('❌ Call state has no events object, reinitializing');
            callState.events = {
                callConnected: false,
                callStarted: false,
                participantAdded: false,
                greetingPlayed: false
            };
        }
        
        console.log(`🔄 Updating call state with patient data (preserving ALL existing event flags)`);
        
        // Preserve ALL existing event flags before updating
        const existingEvents = { ...callState.events };
        
        // Update the state object directly with patient data
        callState.patient = patient;
        callState.patientBot = patientBot;
        callState.events.callConnected = true;
        callState.status = 'connected';
        
        // CRITICAL: Preserve ALL other event flags that might have been set by earlier events
        callState.events.callStarted = existingEvents.callStarted || false;
        callState.events.participantAdded = existingEvents.participantAdded || false;
        callState.events.greetingPlayed = existingEvents.greetingPlayed || false;
        
        console.log(`🔧 Preserved and updated event flags: Started=${callState.events.callStarted}, Participant=${callState.events.participantAdded}`);
        
        // Ensure timeout is set if not already
        if (!callState.timeoutId) {
            setCallTimeout(callConnectionId);
        }

        console.log(`✅ Call state initialized for patient: ${patient.patientName} (${patient.phoneNumber})`);
        console.log(`🔄 Call state tracking ID: ${callConnectionId}`);
        
        // Check if we can start the greeting now (might be ready if other events already arrived)
        await checkAndStartGreeting(callConnectionId);
        
    } catch (error) {
        console.error('❌ Error in handleCallConnected:', error.message);
        cleanupCallState(callConnectionId);
    }
}

/**
 * Get or create call state - ensures we always work with the same state object
 */
function getOrCreateCallState(callConnectionId, eventName) {
    if (!callConnectionId) {
        console.error('❌ No callConnectionId provided to getOrCreateCallState');
        return null;
    }
    
    let callState = callStates.get(callConnectionId);
    
    if (!callState) {
        console.log(`⚠️ No call state found for ${eventName}, creating basic state for: ${callConnectionId}`);
        
        // Create a temporary call state to handle events that arrive before CallConnected
        const tempCallState = {
            patient: null, // Will be filled when CallConnected arrives
            patientBot: null,
            conversationHistory: [],
            callStartTime: new Date(),
            status: 'initializing',
            events: {
                callConnected: false,
                callStarted: false,
                participantAdded: false,
                greetingPlayed: false
            },
            participants: new Set(),
            timeoutId: null
        };
        
        callStates.set(callConnectionId, tempCallState);
        setCallTimeout(callConnectionId);
        callState = tempCallState;
        
        console.log(`✅ Temporary call state created for early ${eventName} event`);
    } else {
        console.log(`✅ Found existing call state for ${eventName} event`);
    }
    
    // Double-check the state object has all required properties
    if (!callState.events) {
        callState.events = {
            callConnected: false,
            callStarted: false,
            participantAdded: false,
            greetingPlayed: false
        };
        console.log(`🔧 Added missing events object to call state`);
    }
    
    return callState;
}

async function handleCallStarted(event) {
    const { callConnectionId } = event;
    console.log(`🚀 Call started event for: ${callConnectionId}`);
    
    // Wait a brief moment for CallConnected to finish if it's in progress
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Get or create call state - ensures we work with the same object reference
    const callState = getOrCreateCallState(callConnectionId, 'CallStarted');
    
    // Update the event flag on the SAME state object
    callState.events.callStarted = true;
    callState.status = 'started';
    
    console.log(`✅ Call started for patient: ${callState.patient?.patientName || 'Unknown'}`);
    console.log(`🔧 Updated callStarted flag to: ${callState.events.callStarted}`);
    
    // Check if we can start the greeting now (if patient data is available)
    if (callState.patient) {
        console.log(`🎯 CallStarted: Patient data available, checking greeting conditions`);
        await checkAndStartGreeting(callConnectionId);
    } else {
        console.log(`⏳ CallStarted processed but waiting for patient data from CallConnected`);
    }
}

async function handleCallParticipantAdded(event) {
    const { callConnectionId, data } = event;
    console.log(`👤 Participant added to call: ${callConnectionId}`);
    
    // Use atomic state management to ensure we work with the same state object
    const callState = getOrCreateCallState(callConnectionId, 'CallParticipantAdded');
    
    // Process participant data
    if (data && data.participant) {
        const participantId = data.participant.identifier?.phoneNumber?.value || data.participant.identifier?.rawId;
        if (participantId) {
            callState.participants.add(participantId);
            console.log(`✅ Participant ${participantId} added to call state`);
            
            // If we have patient data, do phone number matching
            if (callState.patient) {
                const patientPhone = callState.patient.phoneNumber;
                const normalizedPatientPhone = patientPhone?.replace(/[\s\-\(\)]/g, '');
                const normalizedParticipantId = participantId.replace(/[\s\-\(\)]/g, '');
                
                console.log(`🔍 Comparing phones: Patient=${normalizedPatientPhone}, Participant=${normalizedParticipantId}`);
                
                // Check if this is the patient participant (flexible matching)
                if (normalizedParticipantId === normalizedPatientPhone || 
                    normalizedParticipantId.endsWith(normalizedPatientPhone.slice(-10)) ||
                    normalizedPatientPhone.endsWith(normalizedParticipantId.slice(-10))) {
                    
                    callState.events.participantAdded = true;
                    console.log(`🎯 Patient participant confirmed: ${participantId}`);
                    
                    // Check if we can start the greeting now
                    await checkAndStartGreeting(callConnectionId);
                } else {
                    console.log(`ℹ️ Non-patient participant: ${participantId}`);
                }
            } else {
                // No patient data yet, assume this is the patient for now
                callState.events.participantAdded = true;
                console.log(`🔄 Participant added but no patient data yet - assuming it's the patient`);
            }
        } else {
            console.log(`⚠️ No participant ID found in participant data`);
        }
    } else {
        console.log(`⚠️ No participant data in CallParticipantAdded event`);
        
        // IMPORTANT: Try to extract participant from the event subject/path if available
        // The participant phone number is often in the URL path like /participant/+919158066045
        if (event && event.subject) {
            const participantMatch = event.subject.match(/\/participant\/(\+?\d+)/);
            if (participantMatch) {
                const extractedPhone = participantMatch[1];
                callState.participants.add(extractedPhone);
                console.log(`✅ Extracted participant phone from subject: ${extractedPhone}`);
                
                // Mark participant as added since we found evidence of a participant
                if (!callState.events.participantAdded) {
                    callState.events.participantAdded = true;
                    console.log(`🔄 Marked participant as added based on extracted phone number`);
                    
                    // Check if we can start the greeting now (if patient data is available)
                    if (callState.patient) {
                        await checkAndStartGreeting(callConnectionId);
                    }
                }
                return; // Exit early since we found and processed the participant
            }
        }
        
        // As a fallback, if we don't have participant data but got the event,
        // assume it's the patient joining
        if (!callState.events.participantAdded) {
            console.log(`🔄 Fallback: Assuming patient joined based on CallParticipantAdded event`);
            callState.events.participantAdded = true;
            
            // Check if we can start the greeting now (if patient data is available)
            if (callState.patient) {
                await checkAndStartGreeting(callConnectionId);
            }
        }
    }
}

async function handleParticipantsUpdated(event) {
    const { callConnectionId } = event;
    console.log(`📋 Participants updated for call: ${callConnectionId}`);
    
    // Wait a brief moment for CallConnected to finish if it's in progress
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Get or create call state - ensures we work with the same object reference
    const callState = getOrCreateCallState(callConnectionId, 'ParticipantsUpdated');
    
    // Use this as a fallback to mark participant as added if we missed the specific event
    if (!callState.events.participantAdded) {
        callState.events.participantAdded = true;
        console.log(`✅ Participant marked as added via ParticipantsUpdated event`);
        
        // Check if we can start the greeting now (if patient data is available)
        if (callState.patient) {
            console.log(`🎯 ParticipantsUpdated: Patient data available, checking greeting conditions`);
            await checkAndStartGreeting(callConnectionId);
        } else {
            console.log(`⏳ ParticipantsUpdated processed but waiting for patient data from CallConnected`);
        }
    } else {
        console.log(`ℹ️ Participant already marked as added, no action needed`);
    }
}

async function handlePlayStarted(event) {
    const { callConnectionId } = event;
    console.log(`🔊 Audio playback started for call: ${callConnectionId}`);
}

// Central function to check if all conditions are met to start the greeting
async function checkAndStartGreeting(callConnectionId) {
    const callState = callStates.get(callConnectionId);
    
    if (!callState) {
        console.log(`⚠️ No call state found for ${callConnectionId} - cannot start greeting`);
        console.log(`🔍 Available call states: ${Array.from(callStates.keys()).join(', ')}`);
        return;
    }
    
    if (callState.events.greetingPlayed) {
        console.log(`✅ Greeting already played for call ${callConnectionId}`);
        return; // Already played
    }
    
    const { callConnected, callStarted, participantAdded } = callState.events;
    
    console.log(`🔍 Event status for call ${callConnectionId}:`);
    console.log(`   📞 Connected: ${callConnected}`);
    console.log(`   🚀 Started: ${callStarted}`);
    console.log(`   👤 Participant: ${participantAdded}`);
    console.log(`   🎤 Greeting played: ${callState.events.greetingPlayed}`);
    console.log(`   👨‍⚕️ Patient: ${callState.patient?.patientName || 'Unknown'}`);
    console.log(`   📊 Status: ${callState.status}`);
    console.log(`   🎯 Participants count: ${callState.participants?.size || 0}`);
    
    // Check if all required events have occurred
    if (callConnected && callStarted && participantAdded) {
        console.log(`🎉 All events ready for call ${callConnectionId}, starting greeting...`);
        
        try {
            // Mark greeting as being played to prevent duplicates
            callState.events.greetingPlayed = true;
            
            // Reduced delay for faster response time
            setTimeout(async () => {
                await startGreeting(callConnectionId);
            }, 500); // Reduced from 750ms to 500ms for faster response
            
        } catch (error) {
            console.error('❌ Error starting greeting:', error.message);
            callState.events.greetingPlayed = false; // Reset on error
        }
    } else {
        console.log(`⏳ Waiting for more events. Connected: ${callConnected}, Started: ${callStarted}, Participant: ${participantAdded}`);
    }
}

async function startGreeting(callConnectionId) {
    try {
        const callConnection = callClient.getCallConnection(callConnectionId);
        const callState = callStates.get(callConnectionId);
        
        if (!callState) {
            console.error(`❌ No call state found when starting greeting for: ${callConnectionId}`);
            return;
        }
        
        console.log(`🎤 Starting greeting for patient: ${callState.patient.patientName}`);
        console.log(`📞 Call connection ID: ${callConnection.callConnectionId}`);
        
        // Generate personalized greeting using PatientBot
        let greeting;
        if (callState.patientBot) {
            try {
                greeting = await callState.patientBot.processMessage('__START_CALL__');
                console.log('✅ PatientBot generated greeting successfully');
                console.log(`📝 Generated greeting: "${greeting}"`);
            } catch (error) {
                console.error('❌ Error generating PatientBot greeting:', error.message);
                // Fallback to basic greeting
                greeting = `Hello ${callState.patient.patientName}. This is Jenny, your virtual healthcare assistant from the post-discharge care team, calling on behalf of Dr. ${callState.patient.doctorName}. Is now a good time to talk briefly about your medication?`;
            }
        } else {
            // Fallback greeting when PatientBot is not available
            greeting = `Hello ${callState.patient.patientName}. This is Jenny, your virtual healthcare assistant from the post-discharge care team, calling on behalf of Dr. ${callState.patient.doctorName}. Is now a good time to talk briefly about your medication?`;
        }
        
        console.log(`🎙️ About to play greeting: "${greeting}"`);
        await playTextToPatient(callConnection, greeting, { operationContext: 'greeting-playback' });
        console.log(`✅ Greeting playback initiated successfully`);
        
    } catch (error) {
        console.error('❌ Error in startGreeting:', error.message);
        console.error('📊 Error stack:', error.stack);
        
        const callState = callStates.get(callConnectionId);
        if (callState) {
            callState.events.greetingPlayed = false; // Reset on error
            console.log('🔄 Reset greetingPlayed flag due to error');
        }
    }
}

async function handleRecognizeCompleted(event) {
    const callConnectionId = event.callConnectionId || event.data?.callConnectionId;
    const eventData = event.data || event;
    const { result, operationContext } = eventData;

    try {
        const callConnection = callClient.getCallConnection(callConnectionId);
        const callState = callStates.get(callConnectionId);
        
        if (!callState) {
            console.error('❌ No call state found for:', callConnectionId);
            return;
        }

        // ENHANCED DEBUGGING: Log the complete recognition result
        console.log('🔍 SPEECH RECOGNITION DEBUG:');
        console.log('   📊 Full event data:', JSON.stringify(eventData, null, 2));
        console.log('   📊 Result object:', JSON.stringify(result, null, 2));
        console.log('   📊 Result keys:', Object.keys(result || {}));
        
        if (result) {
            console.log('   🎯 Result.speech:', result.speech);
            console.log('   🎯 Result.speechRecognitionResult:', result.speechRecognitionResult);
            console.log('   🎯 Result.recognitionType:', result.recognitionType);
            console.log('   🎯 Result.collectTonesResult:', result.collectTonesResult);
        }

        let userText = '';
        
        // ENHANCED SPEECH EXTRACTION - Try multiple result paths with priority order
        console.log('🔍 Attempting speech extraction from multiple sources...');
        
        const speechSources = [
            () => eventData?.speechResult?.speech,
            () => result?.speech,
            () => result?.speechRecognitionResult?.speech,
            () => result?.speechRecognitionResult?.text,
            () => eventData?.result?.speech,
            () => eventData?.recognitionResult?.speech,
            () => eventData?.speechToTextResult?.text,
            () => eventData?.text
        ];
        
        for (let i = 0; i < speechSources.length; i++) {
            try {
                const speech = speechSources[i]();
                if (speech && typeof speech === 'string' && speech.trim()) {
                    userText = speech.trim();
                    console.log(`[STT] ✅ Extracted speech from source ${i + 1}: "${userText}" (Context: ${operationContext})`);
                    if (eventData?.speechResult?.confidence) {
                        console.log(`[STT] 🎯 Confidence: ${eventData.speechResult.confidence}`);
                    }
                    break;
                }
            } catch (e) {
                // Continue to next source
                console.log(`[STT] � Source ${i + 1} failed, trying next...`);
            }
        }
        
        if (!userText) {
            console.log('🔇 No speech detected from any source, providing contextual continuation prompt');
            console.log('🔍 Available result fields:', Object.keys(result || {}));
            
            // Enhanced continuation prompt based on conversation state
            const conversationState = callState.patientBot?.getConversationState();
            let continuationPrompt = "I didn't catch that. ";
            
            if (!conversationState?.triageCompleted) {
                continuationPrompt += "Could you please tell me how you've been feeling since your discharge?";
            } else if (!conversationState?.adherenceCompleted) {
                continuationPrompt += "Are you taking your medication as prescribed?";
            } else if (!conversationState?.schedulingCompleted) {
                continuationPrompt += "Would you like to schedule your follow-up appointment?";
            } else {
                continuationPrompt += "Is there anything else I can help you with today?";
            }
            
            await playTextToPatient(callConnection, continuationPrompt, { operationContext: 'continuation-prompt' });
            return;
        }

        console.log(`✍️ Processing user input: "${userText}"`);

        let agentReply;
        if (callState.patientBot) {
            try {
                // PRE-PROCESSING: Check conversation state before message processing
                const preState = callState.patientBot.getConversationState();
                console.log(`📈 [PRE] Current Agent: ${preState.activeAgent} | Progress: Triage=${preState.triageCompleted}, Adherence=${preState.adherenceCompleted}, Scheduling=${preState.schedulingCompleted}`);
                
                // Enhanced message processing with context
                const startTime = Date.now();
                agentReply = await callState.patientBot.processMessage(userText);
                const processingTime = Date.now() - startTime;
                
                console.log(`✅ PatientBot response generated in ${processingTime}ms`);
                
                // POST-PROCESSING: Analyze state changes and agent transitions
                const postState = callState.patientBot.getConversationState();
                console.log(`📊 [POST] Current Agent: ${postState.activeAgent} | Progress: Triage=${postState.triageCompleted}, Adherence=${postState.adherenceCompleted}, Scheduling=${postState.schedulingCompleted}`);
                
                // Detect and log agent transitions
                if (preState.activeAgent !== postState.activeAgent) {
                    console.log(`🔄 AGENT TRANSITION: ${preState.activeAgent} → ${postState.activeAgent}`);
                    
                    // Log completion milestones
                    if (!preState.triageCompleted && postState.triageCompleted) {
                        console.log('🎯 MILESTONE: Triage assessment completed');
                    }
                    if (!preState.adherenceCompleted && postState.adherenceCompleted) {
                        console.log('🎯 MILESTONE: Medication adherence check completed');
                    }
                    if (!preState.schedulingCompleted && postState.schedulingCompleted) {
                        console.log('🎯 MILESTONE: Appointment scheduling completed');
                    }
                }
                
                // Enhanced response validation
                if (!agentReply || typeof agentReply !== 'string' || agentReply.trim().length === 0) {
                    console.log('⚠️ Empty/invalid response from PatientBot, generating contextual fallback');
                    agentReply = await generateContextualFallback(userText, callState, postState);
                }
                
            } catch (error) {
                console.error('❌ Error generating PatientBot response:', error.message);
                console.error('📊 Error stack:', error.stack);
                const currentState = callState.patientBot?.getConversationState();
                agentReply = await generateContextualFallback(userText, callState, currentState);
            }
        } else {
            console.log('⚠️ Using fallback response - PatientBot not available');
            agentReply = await generateFallbackResponse(userText, callState);
        }
        
        callState.conversationHistory.push({ role: 'user', content: userText, method: 'speech', timestamp: new Date() });
        callState.conversationHistory.push({ role: 'assistant', content: agentReply, timestamp: new Date() });
        
        const conversationState = callState.patientBot?.getConversationState();
        if (conversationState?.callCompleted) {
            console.log('🎯 PatientBot indicates conversation is complete - preparing to end call');
            // The final response from the bot is played, and then a goodbye message.
            await playTextToPatient(callConnection, agentReply, { operationContext: 'final-response-playback' });
            // The hangup logic will be triggered in handlePlayCompleted after 'goodbye-playback'
        } else {
            // Play the bot response, which will trigger recognition on completion via PlayCompleted event
            await playTextToPatient(callConnection, agentReply, { operationContext: 'response-playback' });
        }
        
    } catch (error) {
        console.error('❌ Error in handleRecognizeCompleted:', error.message);
        console.error('📊 Error details:', error.stack);
    }
}

// Generate fallback response when PatientBot is unavailable
async function generateFallbackResponse(userText, callState) {
    try {
        const lowerText = userText.toLowerCase();
        
        // Basic response patterns
        if (lowerText.includes('pain') || lowerText.includes('hurt')) {
            return "I understand you're experiencing pain. Can you tell me more about where it hurts and how severe it is on a scale of 1 to 10?";
        }
        
        if (lowerText.includes('medication') || lowerText.includes('medicine') || lowerText.includes('pill')) {
            return "Let's talk about your medications. Are you taking them as prescribed? Have you missed any doses recently?";
        }
        
        if (lowerText.includes('appointment') || lowerText.includes('schedule') || lowerText.includes('doctor')) {
            return "Would you like to schedule an appointment? I can help you find available times with your healthcare provider.";
        }
        
        if (lowerText.includes('yes') || lowerText.includes('ok') || lowerText.includes('sure')) {
            return "Great! Can you tell me how you've been feeling lately? Any concerns about your health or medications?";
        }
        
        if (lowerText.includes('no') || lowerText.includes('not')) {
            return "I understand. Is there anything else I can help you with today regarding your healthcare?";
        }
        
        if (lowerText.includes('help') || lowerText.includes('question')) {
            return "I'm here to help with your healthcare questions. You can ask me about medications, symptoms, or scheduling appointments.";
        }
        
        // Generic fallback
        return "Thank you for sharing that with me. Can you tell me more about how you've been feeling lately, or if you have any questions about your medications?";
        
    } catch (error) {
        console.error('❌ Error in generateFallbackResponse:', error.message);
        return "I'm here to help with your healthcare. How can I assist you today?";
    }
}

// Enhanced contextual fallback based on conversation state
async function generateContextualFallback(userText, callState, conversationState) {
    try {
        console.log('🔄 Generating contextual fallback response based on conversation state');
        
        // Track fallback usage
        if (callState) {
            callState.fallbackResponsesUsed = (callState.fallbackResponsesUsed || 0) + 1;
            callState.lastActivity = new Date();
        }
        
        const lowerText = userText.toLowerCase();
        
        // If we have conversation state, provide contextual guidance
        if (conversationState) {
            // Triage phase fallbacks
            if (!conversationState.triageCompleted && conversationState.activeAgent === 'triage') {
                if (lowerText.includes('pain') || lowerText.includes('hurt') || lowerText.includes('feel')) {
                    return "I understand you mentioned pain. Can you help me understand more specifically - where does it hurt, and on a scale of 1 to 10, how would you rate the pain level?";
                }
                if (lowerText.includes('good') || lowerText.includes('fine') || lowerText.includes('ok')) {
                    return "I'm glad to hear you're feeling okay. Let me ask a few specific questions about your recovery. Have you experienced any unusual symptoms like dizziness, nausea, or difficulty sleeping?";
                }
                return "I want to make sure I understand how you're recovering. Can you tell me about any symptoms you've experienced since your discharge - things like pain, nausea, difficulty sleeping, or any other concerns?";
            }
            
            // Adherence phase fallbacks
            if (conversationState.triageCompleted && !conversationState.adherenceCompleted && conversationState.activeAgent === 'adherence') {
                if (lowerText.includes('yes') || lowerText.includes('taking') || lowerText.includes('medication')) {
                    return "That's great that you're taking your medications. Can you tell me specifically about any challenges you've had with timing, side effects, or remembering to take them?";
                }
                if (lowerText.includes('no') || lowerText.includes('forgot') || lowerText.includes('missed')) {
                    return "I understand medication schedules can be challenging. Can you tell me which medications you've had trouble with, and what's making it difficult to take them as prescribed?";
                }
                return "Let's talk about your medication routine. Are you taking all your prescribed medications as directed? Have you experienced any side effects or had trouble remembering doses?";
            }
            
            // Scheduling phase fallbacks
            if (conversationState.triageCompleted && conversationState.adherenceCompleted && !conversationState.schedulingCompleted && conversationState.activeAgent === 'scheduling') {
                if (lowerText.includes('yes') || lowerText.includes('schedule') || lowerText.includes('appointment')) {
                    return "Perfect! I can help you schedule that follow-up appointment. Do you have a preferred day of the week or time of day that works best for you?";
                }
                if (lowerText.includes('no') || lowerText.includes('later') || lowerText.includes('not now')) {
                    return "That's perfectly fine. Just remember that follow-up appointments are important for your recovery. Is there anything else I can help you with today?";
                }
                return "Based on our conversation, I'd recommend scheduling a follow-up appointment with your healthcare provider. Would you like me to help you find an available time?";
            }
        }
        
        // Generic contextual fallback if no specific state match
        const genericResponses = [
            "I want to make sure I'm helping you effectively. Could you please rephrase that or let me know what specific aspect of your healthcare you'd like to discuss?",
            "I'm here to help with your recovery. Would you like to talk about how you're feeling, your medications, or scheduling an appointment?",
            "Let me make sure I understand what you need. Are you calling about symptoms, medication questions, or to schedule a follow-up?"
        ];
        
        const randomIndex = Math.floor(Math.random() * genericResponses.length);
        return genericResponses[randomIndex];
        
    } catch (error) {
        console.error('❌ Error in generateContextualFallback:', error.message);
        return "I'm here to help with your healthcare needs. How can I assist you today?";
    }
}

async function handleRecognizeFailed(event) {
    const callConnectionId = event.callConnectionId || event.data?.callConnectionId;
    const eventData = event.data || event;
    const { result, operationContext } = eventData;
    
    console.error(`❌ Speech recognition failed for call ${callConnectionId}:`);
    console.error('   📊 Full error result:', JSON.stringify(result, null, 2));
    console.error('   📊 Failure reason:', result?.reason);
    console.error('   📊 Error code:', result?.errorCode);
    console.error('   📊 Sub code:', result?.subCode);
    console.error('   📊 Context:', operationContext);

    try {
        const callConnection = callClient.getCallConnection(callConnectionId);
        const callState = callStates.get(callConnectionId);
        
        if (!callState) {
            console.error('❌ No call state found for recognition failure:', callConnectionId);
            return;
        }
        
        // Determine the appropriate response based on the failure reason
        let responseMessage;
        if (result?.reason?.includes('NoSpeechDetected') || result?.reason?.includes('InitialSilenceTimeout')) {
            responseMessage = "I didn't hear anything. Please speak clearly after the beep and I'll listen.";
        } else if (result?.reason?.includes('EndSilenceTimeout')) {
            responseMessage = "I'm having trouble hearing you clearly. Could you please speak a bit louder?";
        } else if (result?.reason?.includes('AudioQuality')) {
            responseMessage = "The audio quality seems poor. Could you please speak more clearly?";
        } else {
            responseMessage = "I'm having trouble with the audio connection. Let me try to listen again.";
        }
        
        console.log(`🔄 Speech recognition failed (${result?.reason || 'Unknown'}) - providing specific guidance`);
        await playTextToPatient(callConnection, responseMessage, { operationContext: 'reprompt-playback' });
        
    } catch (error) {
        console.error('❌ Error handling recognize failure:', error.message);
    }
}

async function handlePlayCompleted(event) {
    const callConnectionId = event.callConnectionId || event.data?.callConnectionId;
    const eventData = event.data || event;
    const { operationContext } = eventData;
    console.log(`✅ Audio playback completed for call: ${callConnectionId}, Context: ${operationContext}`);

    try {
        const callConnection = callClient.getCallConnection(callConnectionId);
        if (!callConnection) {
            console.error(`❌ No call connection found for ${callConnectionId} in handlePlayCompleted`);
            return;
        }

        // If the greeting, a reprompt, or a standard response finished, start listening again.
        if (operationContext === 'greeting-playback' || operationContext === 'reprompt-playback' || operationContext === 'response-playback') {
            console.log(`▶️ Playback for '${operationContext}' completed, starting speech recognition.`);
            // Add a small delay to ensure the media channel is fully released
            setTimeout(() => startSpeechRecognition(callConnection), 100);
        } else if (operationContext === 'final-response-playback') {
            // After the bot's final response, play the goodbye message.
            console.log('▶️ Final response played, now playing goodbye message.');
            await playTextToPatient(callConnection, "Thank you for speaking with me today. Take care and have a great day!", { operationContext: 'goodbye-playback' });
        } else if (operationContext === 'goodbye-playback') {
            // After the goodbye message, hang up the call.
            console.log('▶️ Goodbye message played, ending call.');
            await callConnection.hangUp();
        }
    } catch (error) {
        console.error(`❌ Error in handlePlayCompleted (Context: ${operationContext}): ${error.message}`);
    }
}

async function handlePlayFailed(event) {
    const callConnectionId = event.callConnectionId || event.data?.callConnectionId;
    const eventData = event.data || event;
    const { result, operationContext } = eventData;
    console.error(`❌ Audio playback failed for call ${callConnectionId}:`, result?.reason, `(Context: ${operationContext})`);
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
async function playTextToPatient(callConnection, text, options = {}) {
    try {
        const { operationContext } = options;
        console.log(`🔊 Playing to patient: "${text}" (Context: ${operationContext || 'None'})`);

        const plainText = text.replace(/<[^>]*>/g, '').trim();
        if (!plainText) {
            console.error('❌ No text to play after SSML cleanup');
            return;
        }

        const playRequest = {
            kind: 'textSource',
            text: plainText,
            voiceName: 'en-US-JennyNeural',
            sourceLocale: 'en-US'
        };

        const playOptions = {};
        if (operationContext) {
            playOptions.operationContext = operationContext;
        }

        try {
            await callConnection.getCallMedia().playToAll([playRequest], playOptions);
            console.log('✅ Speech playback initiated successfully with context:', operationContext);
        } catch (speechError) {
            console.error('❌ Primary speech method failed:', speechError.message);
            // Attempt fallbacks if necessary, passing the same playOptions
            playRequest.voiceName = 'en-US-AriaNeural';
            try {
                await callConnection.getCallMedia().playToAll([playRequest], playOptions);
                console.log('✅ Fallback speech with AriaNeural voice initiated.');
            } catch (fallbackError) {
                console.error('❌ All speech methods failed:', fallbackError.message);
                throw new Error('All speech playback methods failed');
            }
        }
    } catch (error) {
        console.error('❌ Error in playTextToPatient:', error.message);
        throw error;
    }
}

async function startSpeechRecognition(callConnection) {
    try {
        const callConnectionId = callConnection.callConnectionId;
        const callState = callStates.get(callConnectionId);
        
        if (!callState) {
            console.error('❌ No call state for speech recognition');
            return;
        }
        
        console.log(`🎤 Starting speech recognition for call: ${callConnectionId}`);
        console.log(`🔍 Available participants in call state:`, Array.from(callState.participants || []));
        
        const callMedia = callConnection.getCallMedia();
        if (!callMedia) {
            console.error('❌ No call media interface available for speech recognition');
            return;
        }

        // CRITICAL FIX: Use the actual participant from the call, prioritizing valid phone numbers
        // We need to target the correct participant phone number, not invalid IDs like "8"
        let targetParticipant;
        
        if (callState.participants && callState.participants.size > 0) {
            // Find the first valid phone number participant (starts with +)
            const participantArray = Array.from(callState.participants);
            const validPhoneParticipant = participantArray.find(p => p && p.startsWith && p.startsWith('+'));
            
            if (validPhoneParticipant) {
                console.log(`✅ Using valid phone participant from call events: ${validPhoneParticipant}`);
                targetParticipant = {
                    kind: 'phoneNumber',
                    phoneNumber: validPhoneParticipant
                };
            } else {
                // If no valid phone number found, use the patient's database phone number as fallback
                const patientPhone = callState.patient?.phoneNumber;
                if (patientPhone) {
                    console.log(`🔄 Using patient database phone as fallback: ${patientPhone}`);
                    targetParticipant = {
                        kind: 'phoneNumber',
                        phoneNumber: patientPhone
                    };
                } else {
                    console.log(`⚠️ No valid phone participants found, attempting generic recognition`);
                    targetParticipant = undefined;
                }
            }
        } else {
            // Fallback: use patient database phone number
            const patientPhone = callState.patient?.phoneNumber;
            if (patientPhone) {
                console.log(`🔄 No call participants found, using patient database phone: ${patientPhone}`);
                targetParticipant = {
                    kind: 'phoneNumber',
                    phoneNumber: patientPhone
                };
            } else {
                console.log(`⚠️ No participants or patient phone found, using generic recognition approach`);
                targetParticipant = undefined;
            }
        }

        // ENHANCED SPEECH RECOGNITION: Optimized for natural conversation flow
        const recognizeOptions = {
            kind: 'callMediaRecognizeSpeechOptions',
            endSilenceTimeoutInSeconds: 4,  // Allow 4 seconds for natural pauses
            initialSilenceTimeoutInSeconds: 10, // Give users 10 seconds to start speaking
            speechLanguage: 'en-US',
            operationContext: `speech-${callConnectionId}-${Date.now()}`,
            playPrompt: undefined,
            
            // ENHANCED SETTINGS FOR NATURAL CONVERSATION
            interruptPromptAndCallWaitForSpeech: false,
            speechToTextOptions: {
                endSilenceTimeoutInMs: 4000,  // 4 seconds for natural conversation flow
                segmentationSilenceTimeoutInMs: 800,  // Allow for natural speech patterns
            }
        };

        console.log(`🔧 Speech recognition setup:`);
        if (targetParticipant) {
            console.log(`   🎯 Target participant:`, JSON.stringify(targetParticipant, null, 2));
        } else {
            console.log(`   🎯 Target: All participants (generic recognition)`);
        }
        console.log(`   ⚙️ Options:`, JSON.stringify(recognizeOptions, null, 2));
        
        // Verify the fix
        console.log(`✅ SDK validation - kind property:`, recognizeOptions.kind);

        // Track speech recognition attempt
        if (callState) {
            callState.speechRecognitionAttempts = (callState.speechRecognitionAttempts || 0) + 1;
            callState.lastActivity = new Date();
            console.log(`📊 Speech recognition attempt #${callState.speechRecognitionAttempts} for call ${callConnectionId}`);
        }

        try {
            // Call startRecognizing - with or without specific participant targeting
            if (targetParticipant) {
                await callMedia.startRecognizing(targetParticipant, recognizeOptions);
                console.log('🎉 Speech recognition started successfully with specific participant targeting!');
            } else {
                // Some SDK versions support recognition without specific participant targeting
                // This targets all participants in the call
                await callMedia.startRecognizing(recognizeOptions);
                console.log('🎉 Speech recognition started successfully with generic participant targeting!');
            }
        } catch (primaryError) {
            console.error('❌ Primary recognition approach failed:', primaryError.message);
            
            // FALLBACK 1: Try with generic participant targeting if specific targeting failed
            if (targetParticipant) {
                console.log('🔄 Trying fallback: generic participant targeting...');
                try {
                    await callMedia.startRecognizing(recognizeOptions);
                    console.log('✅ Fallback speech recognition started successfully!');
                    return; // Success with fallback
                } catch (fallbackError) {
                    console.error('❌ Fallback generic targeting also failed:', fallbackError.message);
                }
            }
            
            // FALLBACK 2: Try with simplified options
            console.log('🔄 Trying fallback: simplified recognition options...');
            try {
                const simplifiedOptions = {
                    kind: 'callMediaRecognizeSpeechOptions',
                    endSilenceTimeoutInSeconds: 5,
                    initialSilenceTimeoutInSeconds: 10,
                    speechLanguage: 'en-US',
                    operationContext: `speech-fallback-${callConnectionId}-${Date.now()}`
                };
                
                if (targetParticipant) {
                    await callMedia.startRecognizing(targetParticipant, simplifiedOptions);
                } else {
                    await callMedia.startRecognizing(simplifiedOptions);
                }
                console.log('✅ Simplified speech recognition started successfully!');
                return; // Success with simplified options
            } catch (simplifiedError) {
                console.error('❌ Simplified recognition also failed:', simplifiedError.message);
            }
            
            // If all fallbacks fail, throw the original error
            throw primaryError;
        }
        
    } catch (recognizeError) {
        console.error('❌ Recognition setup failed:', recognizeError.message);
        console.error('📊 Full error:', recognizeError);
        
        // Provide specific guidance for participant-related errors
        if (recognizeError.message.includes('Participant not found')) {
            console.error('🚨 PARTICIPANT NOT FOUND - This means:');
            console.error('   1. The phone number we\'re targeting doesn\'t match any participant in the call');
            console.error('   2. The participant may have disconnected');
            console.error('   3. There might be a mismatch between database and actual call participant');
            
            // Log current call state for debugging
            const callState = callStates.get(callConnection.callConnectionId);
            if (callState) {
                console.error('🔍 Debug info:');
                console.error(`   📞 Patient DB phone: ${callState.patient?.phoneNumber || 'None'}`);
                console.error(`   👥 Call participants: ${Array.from(callState.participants || []).join(', ')}`);
                console.error(`   📊 Call status: ${callState.status}`);
            }
        }
    }
}

async function generateFallbackResponse(userText, callState) {
    // FALLBACK: Basic rule-based responses when PatientBot is not available
    // This ensures the voice server can still function if PatientBot fails
    
    const patient = callState.patient;
    const conversationLength = callState.conversationHistory.length;
    
    // Simple rule-based responses for emergency fallback
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
        
        // Create call with cognitive services configuration for TTS/STT
        const createCallOptions = {
            cognitiveServicesEndpoint: SPEECH_ENDPOINT
        };
        
        console.log(`🎤 Using cognitive services endpoint in call creation: ${SPEECH_ENDPOINT}`);
        
        const createCallResult = await callClient.createCall(
            callInvite,
            callbackUrl,
            createCallOptions
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
            startTime: new Date(),
            // Conversation tracking metrics
            speechRecognitionAttempts: 0,
            fallbackResponsesUsed: 0,
            lastActivity: new Date()
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

// --- CONVERSATION MONITORING DASHBOARD HTML ---
app.get('/dashboard', (req, res) => {
    const dashboardHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Voice Bot Conversation Dashboard</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        .header h1 { margin: 0; font-size: 28px; }
        .header p { margin: 5px 0 0 0; opacity: 0.9; }
        .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
        .summary-card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
        .summary-card h3 { margin: 0 0 10px 0; color: #333; font-size: 14px; text-transform: uppercase; }
        .summary-card .number { font-size: 32px; font-weight: bold; color: #667eea; margin: 0; }
        .conversations { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .conversations h2 { margin-top: 0; color: #333; }
        .conversation-card { border: 1px solid #eee; border-radius: 8px; padding: 15px; margin-bottom: 15px; background: #fafafa; }
        .conversation-header { display: flex; justify-content: between; align-items: center; margin-bottom: 10px; }
        .patient-name { font-weight: bold; color: #333; }
        .call-duration { color: #666; font-size: 14px; }
        .progress-bar { background: #e0e0e0; height: 20px; border-radius: 10px; overflow: hidden; margin: 10px 0; }
        .progress-fill { height: 100%; display: flex; }
        .progress-triage { background: #4CAF50; }
        .progress-adherence { background: #2196F3; }
        .progress-scheduling { background: #FF9800; }
        .progress-complete { background: #9C27B0; }
        .agent-status { display: inline-block; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
        .agent-triage { background: #e8f5e8; color: #2e7d32; }
        .agent-adherence { background: #e3f2fd; color: #1565c0; }
        .agent-scheduling { background: #fff3e0; color: #ef6c00; }
        .agent-complete { background: #f3e5f5; color: #7b1fa2; }
        .refresh-btn { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-bottom: 20px; }
        .refresh-btn:hover { background: #5a6fd8; }
        .no-calls { text-align: center; color: #666; padding: 40px; }
        .timestamp { color: #999; font-size: 12px; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🤖 Voice Bot Conversation Dashboard</h1>
        <p>Real-time monitoring of patient conversations</p>
    </div>

    <button class="refresh-btn" onclick="loadDashboard()">🔄 Refresh Dashboard</button>
    
    <div class="summary-grid" id="summary-grid">
        <!-- Summary cards will be loaded here -->
    </div>

    <div class="conversations">
        <h2>📞 Active Conversations</h2>
        <div id="conversations-list">
            <!-- Conversations will be loaded here -->
        </div>
    </div>

    <script>
        function formatDuration(seconds) {
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return mins + ':' + secs.toString().padStart(2, '0');
        }

        function getProgressPercentage(state) {
            if (!state) return 0;
            let progress = 0;
            if (state.triageCompleted) progress += 33;
            if (state.adherenceCompleted) progress += 33;
            if (state.schedulingCompleted) progress += 34;
            return progress;
        }

        function getAgentStatusClass(agent) {
            const classes = {
                'triage': 'agent-triage',
                'adherence': 'agent-adherence', 
                'scheduling': 'agent-scheduling',
                'complete': 'agent-complete'
            };
            return classes[agent] || 'agent-triage';
        }

        function renderSummary(summary) {
            const summaryGrid = document.getElementById('summary-grid');
            summaryGrid.innerHTML = \`
                <div class="summary-card">
                    <h3>Active Calls</h3>
                    <div class="number">\${summary.totalActiveCalls}</div>
                </div>
                <div class="summary-card">
                    <h3>In Progress</h3>
                    <div class="number">\${summary.conversationsInProgress}</div>
                </div>
                <div class="summary-card">
                    <h3>Triage Complete</h3>
                    <div class="number">\${summary.triageCompleted}</div>
                </div>
                <div class="summary-card">
                    <h3>Adherence Complete</h3>
                    <div class="number">\${summary.adherenceCompleted}</div>
                </div>
                <div class="summary-card">
                    <h3>Scheduling Complete</h3>
                    <div class="number">\${summary.schedulingCompleted}</div>
                </div>
                <div class="summary-card">
                    <h3>Calls Completed</h3>
                    <div class="number">\${summary.callsCompleted}</div>
                </div>
            \`;
        }

        function renderConversations(conversations) {
            const conversationsList = document.getElementById('conversations-list');
            
            if (conversations.length === 0) {
                conversationsList.innerHTML = '<div class="no-calls">No active conversations</div>';
                return;
            }

            conversationsList.innerHTML = conversations.map(conv => {
                const progress = getProgressPercentage(conv.currentState);
                const agentClass = getAgentStatusClass(conv.currentState?.activeAgent);
                
                return \`
                    <div class="conversation-card">
                        <div class="conversation-header">
                            <span class="patient-name">👤 \${conv.patientName} (\${conv.patientId})</span>
                            <span class="call-duration">⏱️ \${formatDuration(conv.duration)}</span>
                        </div>
                        <div class="agent-status \${agentClass}">
                            \${conv.currentState?.activeAgent || 'initializing'}
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: \${progress}%">
                                \${conv.currentState?.triageCompleted ? '<div class="progress-triage" style="width: 33.33%"></div>' : ''}
                                \${conv.currentState?.adherenceCompleted ? '<div class="progress-adherence" style="width: 33.33%"></div>' : ''}
                                \${conv.currentState?.schedulingCompleted ? '<div class="progress-scheduling" style="width: 33.33%"></div>' : ''}
                            </div>
                        </div>
                        <div style="font-size: 12px; color: #666;">
                            💬 \${conv.conversationHistory} exchanges | 
                            📞 Call: \${conv.callId.substring(0, 8)}...
                        </div>
                    </div>
                \`;
            }).join('');
        }

        async function loadDashboard() {
            try {
                const response = await fetch('/api/conversation-status');
                const data = await response.json();
                
                renderSummary(data.summary);
                renderConversations(data.activeConversations);
                
                // Add timestamp
                const timestamp = new Date().toLocaleString();
                document.getElementById('conversations-list').innerHTML += 
                    \`<div class="timestamp">Last updated: \${timestamp}</div>\`;
                
            } catch (error) {
                console.error('Failed to load dashboard:', error);
                document.getElementById('conversations-list').innerHTML = 
                    '<div class="no-calls">❌ Failed to load conversation data</div>';
            }
        }

        // Load dashboard on page load
        loadDashboard();
        
        // Auto-refresh every 10 seconds
        setInterval(loadDashboard, 10000);
    </script>
</body>
</html>
    `;
    
    res.send(dashboardHTML);
});

module.exports = app;
