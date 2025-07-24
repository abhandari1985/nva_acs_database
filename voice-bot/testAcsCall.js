const { CallAutomationClient, KnownRecognizeInputType } = require('@azure/communication-call-automation');
const { PhoneNumberIdentifier } = require('@azure/communication-common');
const express = require('express');
const { PatientBot } = require('./patientBot');
const CosmosDbService = require('./cosmosDbService');
require('dotenv').config();

// Configuration validation
const requiredEnvVars = [
    'ACS_CONNECTION_STRING',
    'ACS_PHONE_NUMBER', 
    'COGNITIVE_SERVICES_ENDPOINT',
    'ACS_CALLBACK_URL'
];

console.log('🔍 Environment Check:');
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingVars.join(', '));
    process.exit(1);
}

/**
 * CONFIGURATION VALIDATION (enhanced from app.js pattern)
 * Validate all required configuration is present
 */
function validateConfiguration() {
    try {
        console.log('🔧 Validating enhanced configuration...');
        
        // Check basic ACS configuration
        if (!process.env.ACS_CONNECTION_STRING) {
            console.error('❌ ACS_CONNECTION_STRING is missing');
            return false;
        }
        
        if (!process.env.ACS_PHONE_NUMBER) {
            console.error('❌ ACS_PHONE_NUMBER is missing');
            return false;
        }
        
        if (!process.env.COGNITIVE_SERVICES_ENDPOINT) {
            console.error('❌ COGNITIVE_SERVICES_ENDPOINT is missing');
            return false;
        }
        
        if (!process.env.ACS_CALLBACK_URL) {
            console.error('❌ ACS_CALLBACK_URL is missing');
            return false;
        }
        
        console.log('✅ All required configuration present');
        console.log(`   📞 ACS Phone: ${process.env.ACS_PHONE_NUMBER}`);
        console.log(`   🧠 Cognitive Services: ${process.env.COGNITIVE_SERVICES_ENDPOINT}`);
        console.log(`   🔗 Callback URL: ${process.env.ACS_CALLBACK_URL}`);
        
        return true;
    } catch (error) {
        console.error('❌ Configuration validation error:', error.message);
        return false;
    }
}

// Global services and state management (atomic pattern from app.js)
const callStates = new Map();
let cosmosDbService;
let app;

/**
 * DATABASE INTEGRATION TASK 1: Initialize Services
 * Initialize CosmosDB service and other core services
 */
async function initializeServices() {
    try {
        console.log('🔧 Initializing services...');
        
        // Initialize CosmosDB service (same as app.js - no init() method needed)
        cosmosDbService = new CosmosDbService();
        console.log('✅ CosmosDB service initialized');
        
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize services:', error.message);
        console.log('⚠️ Continuing with fallback mode (test data only)');
        return false;
    }
}

/**
 * ATOMIC CALL STATE MANAGEMENT (proven pattern from app.js)
 * Thread-safe call state management to prevent race conditions
 */
function getOrCreateCallState(callConnectionId) {
    if (!callStates.has(callConnectionId)) {
        const initialState = {
            callConnectionId,
            patientBot: null,
            patientData: null,
            conversationPhase: 'initializing',
            callState: 'connecting',
            initialized: false,
            conversationStarted: false,
            callConnected: false,
            participantsUpdated: false,
            callStarted: false,
            conversationHistory: [],
            created: new Date().toISOString()
        };
        callStates.set(callConnectionId, initialState);
        console.log(`🆕 Created new call state for ${callConnectionId}`);
    }
    return callStates.get(callConnectionId);
}

/**
 * PATIENTBOT INITIALIZATION (adapted from app.js)
 * Initialize PatientBot for interactive AI conversations
 */
async function initializePatientBot(callState, patientData) {
    try {
        console.log(`🤖 Initializing PatientBot for ${callState.callConnectionId}`);
        
        const patientBot = new PatientBot(patientData);
        callState.patientBot = patientBot;
        callState.patientData = patientData;
        callState.initialized = true;
        
        console.log(`✅ PatientBot initialized for patient: ${patientData.patientName || patientData.name}`);
        return patientBot;
    } catch (error) {
        console.error('❌ Failed to initialize PatientBot:', error.message);
        throw error;
    }
}

/**
 * PHASE 2: INTERACTIVE CONVERSATION FLOW FUNCTIONS
 * Enhanced speech recognition with fallback and DTMF support
 */

/**
 * Enhanced Speech Recognition with Error Handling and Fallback
 * Implements retry logic and DTMF fallback for robust conversation flow
 */
async function startEnhancedSpeechRecognition(callConnectionId, callClient) {
    try {
        console.log(`🎤 Starting enhanced speech recognition for call: ${callConnectionId}`);
        
        const callState = getOrCreateCallState(callConnectionId);
        
        // Configure speech recognition with proper error handling
        const speechOptions = {
            targetParticipant: {
                kind: 'phoneNumber',
                phoneNumber: callState.patientData?.phoneNumber || process.env.ACS_PHONE_NUMBER
            },
            playPrompt: {
                kind: 'textSource',
                text: "Please respond to continue our conversation, or press any key on your phone.",
                voiceName: "en-US-JennyNeural"
            },
            recognizeOptions: {
                interToneTimeout: 2000,
                initialSilenceTimeout: 5000,
                maxTonesToCollect: 1,
                recognizeInputType: KnownRecognizeInputType.Speech,
                dtmfConfig: {
                    maxTonesToCollect: 1,
                    interToneTimeout: 2000,
                    initialSilenceTimeout: 5000
                },
                speechConfig: {
                    endSilenceTimeout: 2000
                }
            },
            operationContext: `speech-recognition-${callConnectionId}-${Date.now()}`
        };
        
        console.log(`🔧 Speech recognition configured with operation context: ${speechOptions.operationContext}`);
        
        // Start recognition with proper error handling
        const callMedia = callClient.getCallConnection(callConnectionId).getCallMedia();
        const recognizeResult = await callMedia.startRecognizing(speechOptions);
        
        console.log(`✅ Speech recognition started successfully for call: ${callConnectionId}`);
        callState.speechRecognitionActive = true;
        
        return recognizeResult;
        
    } catch (error) {
        console.error(`❌ Enhanced speech recognition failed for call ${callConnectionId}:`, error.message);
        
        // Fallback to DTMF-only mode
        return await startDtmfFallback(callConnectionId, callClient);
    }
}

/**
 * DTMF Fallback Mode
 * When speech recognition fails, fall back to keypress detection
 */
async function startDtmfFallback(callConnectionId, callClient) {
    try {
        console.log(`🔢 Starting DTMF fallback for call: ${callConnectionId}`);
        
        const callState = getOrCreateCallState(callConnectionId);
        
        // Configure DTMF-only recognition
        const dtmfOptions = {
            targetParticipant: {
                kind: 'phoneNumber',
                phoneNumber: callState.patientData?.phoneNumber || process.env.ACS_PHONE_NUMBER
            },
            playPrompt: {
                kind: 'textSource',
                text: "Press 1 for Yes, 2 for No, or 0 to speak with someone.",
                voiceName: "en-US-JennyNeural"
            },
            recognizeOptions: {
                recognizeInputType: KnownRecognizeInputType.Dtmf,
                maxTonesToCollect: 1,
                interToneTimeout: 3000,
                initialSilenceTimeout: 10000
            },
            operationContext: `dtmf-fallback-${callConnectionId}-${Date.now()}`
        };
        
        console.log(`🔧 DTMF fallback configured with operation context: ${dtmfOptions.operationContext}`);
        
        const callMedia = callClient.getCallConnection(callConnectionId).getCallMedia();
        const recognizeResult = await callMedia.startRecognizing(dtmfOptions);
        
        console.log(`✅ DTMF fallback started successfully for call: ${callConnectionId}`);
        callState.dtmfFallbackActive = true;
        
        return recognizeResult;
        
    } catch (error) {
        console.error(`❌ DTMF fallback failed for call ${callConnectionId}:`, error.message);
        
        // Final fallback: continue conversation without input
        console.log(`⚠️ Continuing conversation without user input for call: ${callConnectionId}`);
        return null;
    }
}

/**
 * Process Patient Response (Speech or DTMF)
 * Handle both voice and keypress responses for conversation continuity
 */
async function processPatientResponse(callConnectionId, responseData, callClient) {
    try {
        console.log(`💬 Processing patient response for call: ${callConnectionId}`);
        
        const callState = getOrCreateCallState(callConnectionId);
        if (!callState.patientBot) {
            console.error(`❌ PatientBot not initialized for call: ${callConnectionId}`);
            return;
        }
        
        let patientMessage = '';
        let responseType = 'unknown';
        
        // Process different types of responses
        if (responseData.recognizeInputType === 'speech') {
            patientMessage = responseData.speechResult?.speechText || '';
            responseType = 'speech';
            console.log(`🗣️ Speech response: "${patientMessage}"`);
        } else if (responseData.recognizeInputType === 'dtmf') {
            const dtmfTones = responseData.dtmfResult?.tones || [];
            responseType = 'dtmf';
            
            // Convert DTMF to meaningful responses
            if (dtmfTones.includes('1')) {
                patientMessage = 'Yes';
            } else if (dtmfTones.includes('2')) {
                patientMessage = 'No';
            } else if (dtmfTones.includes('0')) {
                patientMessage = 'I need help';
            } else {
                patientMessage = dtmfTones.join('');
            }
            
            console.log(`🔢 DTMF response: ${dtmfTones.join('')} -> "${patientMessage}"`);
        }
        
        if (patientMessage) {
            // Process response through PatientBot
            console.log(`🤖 Sending to PatientBot: "${patientMessage}"`);
            const botResponse = await callState.patientBot.processMessage(patientMessage);
            
            // Play bot response back to patient
            await playBotResponseToPatient(callConnectionId, botResponse, callClient);
            
            // Continue conversation flow
            await continueConversationFlow(callConnectionId, callClient);
            
        } else {
            console.log(`⚠️ No valid response received, continuing conversation...`);
            await continueConversationFlow(callConnectionId, callClient);
        }
        
    } catch (error) {
        console.error(`❌ Error processing patient response for call ${callConnectionId}:`, error.message);
        
        // Fallback: continue with generic response
        await continueConversationFlow(callConnectionId, callClient);
    }
}

/**
 * Play Bot Response to Patient
 * Convert PatientBot response to SSML and play to patient
 */
async function playBotResponseToPatient(callConnectionId, botResponse, callClient) {
    try {
        console.log(`🔊 Playing bot response to patient: ${callConnectionId}`);
        
        const callState = getOrCreateCallState(callConnectionId);
        
        // Use PatientBot's SSML response if available, otherwise convert text
        const ssmlResponse = botResponse.ssml || `<speak version="1.0" xml:lang="en-US">
            <voice name="en-US-JennyNeural" style="customerservice" styledegree="0.8">
                <prosody rate="0.9" pitch="medium">
                    ${botResponse.text || botResponse}
                </prosody>
            </voice>
        </speak>`;
        
        console.log(`📝 SSML Response: ${ssmlResponse}`);
        
        // Play the response
        const callMedia = callClient.getCallConnection(callConnectionId).getCallMedia();
        await callMedia.playToAll([{
            kind: 'ssmlSource',
            ssmlText: ssmlResponse
        }]);
        
        console.log(`✅ Bot response played successfully to call: ${callConnectionId}`);
        
        // Update conversation history
        callState.conversationHistory.push({
            timestamp: new Date().toISOString(),
            type: 'bot_response',
            message: botResponse.text || botResponse,
            ssml: ssmlResponse
        });
        
    } catch (error) {
        console.error(`❌ Error playing bot response to call ${callConnectionId}:`, error.message);
    }
}

/**
 * Continue Conversation Flow
 * Manage the overall conversation flow and determine next steps
 */
async function continueConversationFlow(callConnectionId, callClient) {
    try {
        console.log(`🔄 Continuing conversation flow for call: ${callConnectionId}`);
        
        const callState = getOrCreateCallState(callConnectionId);
        
        // Check if conversation should continue
        if (callState.patientBot?.conversationState?.callCompleted) {
            console.log(`✅ Conversation completed for call: ${callConnectionId}`);
            await endCallGracefully(callConnectionId, callClient);
            return;
        }
        
        // Continue listening for patient responses
        setTimeout(async () => {
            await startEnhancedSpeechRecognition(callConnectionId, callClient);
        }, 2000); // Wait 2 seconds before next recognition
        
    } catch (error) {
        console.error(`❌ Error continuing conversation flow for call ${callConnectionId}:`, error.message);
    }
}

/**
 * End Call Gracefully
 * Properly terminate the call and save conversation data
 */
async function endCallGracefully(callConnectionId, callClient) {
    try {
        console.log(`🔚 Ending call gracefully: ${callConnectionId}`);
        
        const callState = getOrCreateCallState(callConnectionId);
        
        // Play farewell message
        const farewellMessage = `<speak version="1.0" xml:lang="en-US">
            <voice name="en-US-JennyNeural" style="customerservice" styledegree="0.8">
                <prosody rate="0.9" pitch="medium">
                    Thank you for your time today. Take care and have a great day!
                </prosody>
            </voice>
        </speak>`;
        
        const callMedia = callClient.getCallConnection(callConnectionId).getCallMedia();
        await callMedia.playToAll([{
            kind: 'ssmlSource',
            ssmlText: farewellMessage
        }]);
        
        // Wait for message to play, then hang up
        setTimeout(async () => {
            await callClient.getCallConnection(callConnectionId).hangUp(true);
            console.log(`✅ Call ended gracefully: ${callConnectionId}`);
        }, 5000);
        
    } catch (error) {
        console.error(`❌ Error ending call gracefully for call ${callConnectionId}:`, error.message);
    }
}

async function testAcsCall() {
    console.log('🚀 Starting Enhanced Interactive AI Voice Bot Test...');
    
    // Step 1: Initialize services
    console.log('\n📋 Phase 1: Service Initialization');
    const servicesReady = await initializeServices();
    
    // Step 2: Validate configuration
    console.log('\n🔧 Phase 2: Configuration Validation');
    if (!validateConfiguration()) {
        console.error('❌ Configuration validation failed. Exiting.');
        process.exit(1);
    }
    
    // Step 3: Test database connectivity (if available)
    if (servicesReady && cosmosDbService) {
        console.log('\n💾 Phase 3: Database Connectivity Test');
        try {
            // Test fetch patient data (using first available patient)
            const testPatients = await cosmosDbService.getAllPatients();
            if (testPatients && testPatients.length > 0) {
                console.log(`✅ Database connected: Found ${testPatients.length} patients`);
                console.log(`📋 Test patient: ${testPatients[0].name} (${testPatients[0].phoneNumber})`);
            } else {
                console.log('⚠️ Database connected but no patients found');
            }
        } catch (error) {
            console.error('❌ Database connectivity test failed:', error.message);
        }
    }
    
    // Step 4: System readiness confirmation
    console.log('\n🎯 Phase 4: System Ready');
    console.log('===============================================');
    console.log('✅ Enhanced Interactive AI Voice Bot Ready!');
    console.log('===============================================');
    console.log('🤖 PatientBot: Multi-agent AI system loaded');
    console.log('💾 Database: ' + (servicesReady ? 'Connected' : 'Fallback mode'));
    console.log('🔄 State Management: Atomic pattern active');
    console.log('📞 Ready for interactive voice conversations');
    console.log('🎤 Speech Recognition: Enhanced with DTMF fallback');
    console.log('🔀 Conversation Flow: Continuous with error recovery');
    console.log('===============================================');
    
    // Step 5: Initialize test call with enhanced infrastructure
    console.log('\n📞 Phase 5: Enhanced Call Test Preparation');
    
    try {
        console.log('🧪 Preparing Enhanced Interactive AI Call Test...\n');
        
        // Enhanced test data with comprehensive patient information
        let testPatientData;
        
        // Try to fetch real patient data from database first
        if (servicesReady && cosmosDbService) {
            try {
                const allPatients = await cosmosDbService.getAllPatients();
                if (allPatients && allPatients.length > 0) {
                    // Use first available patient from database
                    testPatientData = allPatients[0];
                    // Ensure patientName field exists for PatientBot compatibility
                    if (!testPatientData.patientName && testPatientData.name) {
                        testPatientData.patientName = testPatientData.name;
                    }
                    console.log('📊 Using database patient data');
                } else {
                    console.log('⚠️ No patients in database, using test data');
                }
            } catch (error) {
                console.log('⚠️ Database fetch failed, using test data');
            }
        }
        
        // Fallback to comprehensive test data
        if (!testPatientData) {
            testPatientData = {
                phoneNumber: "+918856866045", // Database phone number for Priya Kapoor
                patientName: "Test Patient Interactive", // Changed from 'name' to 'patientName'
                name: "Test Patient Interactive", // Keep both for compatibility
                age: 45,
                doctorName: "Dr. AI Assistant",
                medications: [
                    { medicationName: "Test Medication", dosage: "10mg", frequency: "Daily" }
                ],
                appointments: [],
                medicalHistory: ["Test condition for interactive AI conversation"],
                conversationPreferences: {
                    preferredLanguage: "English",
                    communicationStyle: "detailed"
                }
            };
            console.log('📊 Using enhanced test patient data');
        }
        
        console.log('📋 Enhanced Call Details:');
        console.log(`  📞 From: ${process.env.ACS_PHONE_NUMBER} (US ACS Number)`);
        console.log(`  📞 To: ${testPatientData.phoneNumber}`);
        console.log(`  👤 Patient: ${testPatientData.patientName || testPatientData.name}`);
        console.log(`  🏥 Doctor: ${testPatientData.doctorName}`);
        console.log(`  💊 Medications: ${testPatientData.medications.length} items`);
        console.log('');
        
        // Initialize call state for this test
        const mockCallConnectionId = `test-call-${Date.now()}`;
        const callState = getOrCreateCallState(mockCallConnectionId);
        
        // Initialize PatientBot for this test (pre-validation)
        console.log('🤖 Pre-initializing PatientBot for validation...');
        await initializePatientBot(callState, testPatientData);
        console.log('✅ PatientBot validation complete');
        console.log('');
        
        if (!process.env.ACS_CONNECTION_STRING) {
            console.error('❌ ACS_CONNECTION_STRING is missing. Cannot proceed.');
            return;
        }
        
        console.log('🚀 Initiating Enhanced Interactive AI Call...');
        
        // Initialize ACS client directly (like diagnoseAcs.js)
        const callClient = new CallAutomationClient(process.env.ACS_CONNECTION_STRING);
        
        // Create the call invite using enhanced patient data
        const callInvite = {
            targetParticipant: {
                kind: 'phoneNumber',
                phoneNumber: testPatientData.phoneNumber
            },
            sourceCallIdNumber: {
                kind: 'phoneNumber', 
                phoneNumber: process.env.ACS_PHONE_NUMBER
            }
        };
        
        console.log('📋 Enhanced Call Configuration:');
        console.log(`   From: ${process.env.ACS_PHONE_NUMBER}`);
        console.log(`   To: ${testPatientData.phoneNumber}`);
        console.log(`   Patient: ${testPatientData.patientName || testPatientData.name}`);
        console.log(`   Callback URL: ${process.env.ACS_CALLBACK_URL}`);
        console.log(`   PatientBot: ${callState.initialized ? 'Ready' : 'Initializing'}\n`);
        
        // Make the call with Cognitive Services configuration (like the working Python version)
        const createCallOptions = {
            cognitiveServicesEndpoint: process.env.COGNITIVE_SERVICES_ENDPOINT,
            callIntelligenceOptions: {
                cognitiveServicesEndpoint: process.env.COGNITIVE_SERVICES_ENDPOINT
            }
        };
        
        console.log('🧠 Cognitive Services Configuration:');
        console.log(`   Endpoint: ${process.env.COGNITIVE_SERVICES_ENDPOINT}`);
        console.log(`   Call Intelligence: Enabled\n`);
        
        const createCallResult = await callClient.createCall(
            callInvite,
            process.env.ACS_CALLBACK_URL,
            createCallOptions
        );
        
        console.log('✅ Enhanced Interactive AI Call Response: Call initiated successfully!');
        console.log('📞 Call Connection ID:', createCallResult.callConnection.callConnectionId);
        console.log('\n🎉 Phase 2 Enhanced Interactive AI Experience - What should happen:');
        console.log('1. Your phone should ring within 30 seconds');
        console.log('2. Answer to hear the AI healthcare assistant greeting');
        console.log('3. 🆕 NEW: After the greeting, you can:');
        console.log('   🗣️ Speak your response naturally, OR');
        console.log('   🔢 Press keys: 1=Yes, 2=No, 0=Help');
        console.log('4. 🆕 NEW: Experience full interactive conversation flow:');
        console.log('   🔸 Triage questions with intelligent follow-ups');
        console.log('   🔸 Medication adherence discussions');
        console.log('   🔸 Appointment scheduling assistance');
        console.log('   🔸 Robust error handling and fallback methods');
        console.log('5. 🆕 NEW: Enhanced features:');
        console.log('   🔄 Conversation continues based on your responses');
        console.log('   🎤 Speech recognition with DTMF backup');
        console.log('   💾 All interactions saved to database');
        console.log('   🔧 Graceful error recovery');
        console.log('6. International calling rates apply');
        console.log('\n💡 Enhanced Monitoring:');
        console.log('📊 Watch voice server logs for:');
        console.log('   🎤 Speech recognition attempts and fallbacks');
        console.log('   🤖 PatientBot multi-agent conversations');
        console.log('   🔄 Conversation flow state management');
        console.log('   💾 Database interaction and persistence');
        console.log('\n🏆 This is Phase 2: Full Interactive Conversation System!');
        
        // Store the actual call connection ID for potential use
        if (callState) {
            callState.callConnectionId = createCallResult.callConnection.callConnectionId;
            callState.realCallClient = callClient; // Store for interactive functions
            console.log(`📋 Call state updated with connection ID: ${callState.callConnectionId}`);
            console.log(`🔧 Interactive conversation functions ready for real-time use`);
        }
        
    } catch (error) {
        console.error('❌ Enhanced interactive test call failed:', error.message);
        console.error('🔍 Error Code:', error.code || 'Unknown');
        console.error('📊 Status Code:', error.statusCode || 'Unknown');
        
        if (error.message.includes('400')) {
            console.log('\n💡 Possible Solutions:');
            console.log('   • Check if international calling is enabled on your ACS resource');
            console.log('   • Verify phone number format (+country_code_number)');
            console.log('   • Ensure ACS phone number is correctly configured');
        } else if (error.message.includes('403')) {
            console.log('\n💡 Possible Solutions:');
            console.log('   • Check ACS resource permissions');
            console.log('   • Verify ACS connection string is correct');
            console.log('   • Ensure calling plan includes outbound calls');
        }
        
        console.log('\n🔧 Enhanced Troubleshooting:');
        console.log('1. Ensure voice server is running: npm run start:voice');
        console.log('2. Ensure Dev Tunnel is active and accessible');
        console.log('3. Check ACS account has international calling enabled');
        console.log('4. Verify phone number format: +918856866045');
        console.log('5. 🆕 Check speech service configuration for recognition');
        console.log('6. 🆕 Verify DTMF capabilities are enabled on ACS');
    }
}

testAcsCall();
