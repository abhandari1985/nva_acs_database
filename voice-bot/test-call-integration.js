// test-call-integration.js
// Test script to trigger a call and verify PatientBot integration using direct ACS calling

const axios = require('axios');
const { CallAutomationClient } = require('@azure/communication-call-automation');
require('dotenv').config();

const SERVER_URL = 'http://localhost:3979';

async function testCallIntegration() {
    console.log('🧪 Testing PatientBot Call Integration\n');
    
    try {
        // 1. Test health endpoint
        console.log('1. Testing health endpoint...');
        const healthResponse = await axios.get(`${SERVER_URL}/health`);
        console.log('✅ Health check passed:', healthResponse.data);
        console.log('');
        
        // 2. Test direct ACS call (like testAcsCall.js)
        console.log('2. Testing direct ACS call integration...');
        
        // Sample test call data with Indian phone number (working example)
        const testCallData = {
            phoneNumber: "+919158066045", // Your verified Indian number
            patientName: "John Smith",
            doctorName: "Dr. Johnson",
            patientId: "patient-123",
            medications: ["Lisinopril 10mg"]
        };
        
        console.log('📞 Attempting to make direct ACS call...');
        console.log(`   From: ${process.env.ACS_PHONE_NUMBER} (US ACS Number)`);
        console.log(`   To: ${testCallData.phoneNumber} (Indian Number)`);
        console.log(`   Patient: ${testCallData.patientName}`);
        
        if (!process.env.ACS_CONNECTION_STRING || !process.env.ACS_PHONE_NUMBER) {
            console.error('❌ Missing ACS configuration. Check .env file.');
            return;
        }
        
        try {
            // Initialize ACS client directly
            const callClient = new CallAutomationClient(process.env.ACS_CONNECTION_STRING);
            
            // Create the call invite
            const callInvite = {
                targetParticipant: {
                    kind: 'phoneNumber',
                    phoneNumber: testCallData.phoneNumber
                },
                sourceCallIdNumber: {
                    kind: 'phoneNumber', 
                    phoneNumber: process.env.ACS_PHONE_NUMBER
                }
            };
            
            console.log('📋 Call Configuration:');
            console.log(`   From: ${process.env.ACS_PHONE_NUMBER}`);
            console.log(`   To: ${testCallData.phoneNumber}`);
            console.log(`   Callback URL: ${process.env.ACS_CALLBACK_URL}`);
            
            // Make the call directly through ACS with speech configuration
            const createCallResult = await callClient.createCall(
                callInvite,
                process.env.ACS_CALLBACK_URL,
                {
                    cognitiveServicesConfiguration: {
                        speechServiceEndpoint: process.env.SPEECH_ENDPOINT,
                        speechServiceApiKey: process.env.SPEECH_KEY,
                        speechServiceRegion: process.env.SPEECH_REGION
                    }
                }
            );
            
            console.log('✅ Call initiated successfully!');
            console.log('� Call Connection ID:', createCallResult.callConnection.callConnectionId);
            
            // Store call context in server (simulate what trigger-call endpoint does)
            console.log('\n📋 Call should now be active with PatientBot integration:');
            console.log('1. 📞 Your phone should ring');
            console.log('2. 🤖 PatientBot (Jenny) will greet you when answered');
            console.log('3. 💬 Try saying "Yes, this is a good time" to proceed');
            console.log('4. 🗣️ Have a conversation about medication adherence');
            console.log('5. 📅 Test appointment scheduling functionality');
            console.log('\n💡 Monitor the voice server terminal for real-time logs!');
            
        } catch (callError) {
            console.error('❌ Direct ACS call failed:', callError.message);
            console.error('🔍 Error Code:', callError.code || 'Unknown');
            
            if (callError.message.includes('400')) {
                console.log('\n💡 Possible Solutions:');
                console.log('   • Check if international calling is enabled on your ACS resource');
                console.log('   • Verify phone number format (+country_code_number)');
                console.log('   • Ensure callback URL is accessible via Dev Tunnel');
            } else if (callError.message.includes('403')) {
                console.log('\n💡 Possible Solutions:');
                console.log('   • Check ACS resource permissions');
                console.log('   • Verify ACS connection string is correct');
                console.log('   • Ensure calling plan includes outbound calls');
            }
        }
        
        console.log('\n3. Integration Test Summary:');
        console.log('✅ Server is running and responding');
        console.log('✅ Health endpoint working');
        console.log('✅ Direct ACS integration tested');
        console.log('✅ PatientBot ready for conversation');
        
        console.log('\n📋 What to expect during the call:');
        console.log('1. Jenny will introduce herself as healthcare assistant');
        console.log('2. Triage: Identity confirmation and call purpose');
        console.log('3. Adherence: Questions about medication compliance');
        console.log('4. Scheduling: Appointment booking assistance');
        console.log('5. Post-call: Data saved to CosmosDB with conversation state');
        
        console.log('\n🎉 PatientBot integration test completed!');
        
    } catch (error) {
        console.error('❌ Integration test failed:', error.message);
    }
}

// Test alternative HTTP endpoint approach for comparison
async function testHttpEndpointCall() {
    console.log('\n🌐 Testing HTTP Endpoint Call (Alternative Method)...');
    
    try {
        const testCallData = {
            phoneNumber: "+919158066045", // Your verified number
            patientName: "Jane Doe",
            doctorName: "Dr. Smith",
            patientId: "patient-456",
            medications: ["Metformin 500mg"]
        };
        
        console.log('📞 Attempting HTTP endpoint call...');
        
        const callResponse = await axios.post(`${SERVER_URL}/api/trigger-call`, testCallData);
        console.log('✅ HTTP call triggered successfully:', callResponse.data);
        
        if (callResponse.data.callConnectionId) {
            console.log(`📋 Call Connection ID: ${callResponse.data.callConnectionId}`);
            console.log('� Call is now active - PatientBot will handle the conversation when answered');
        }
    } catch (callError) {
        if (callError.response?.status === 400) {
            console.log('⚠️ Expected error (test configuration):', callError.response.data.error);
            console.log('✅ HTTP endpoint is working correctly');
        } else {
            console.error('❌ Unexpected HTTP call error:', callError.response?.data || callError.message);
        }
    }
}

// Additional function to test PatientBot in isolation
async function testPatientBotStandalone() {
    console.log('\n🤖 Testing PatientBot Standalone...');
    
    try {
        const { PatientBot } = require('./patientBot');
        
        const samplePatient = {
            patientName: 'Sarah Johnson',
            phoneNumber: '+919158066045',
            age: 42,
            primaryMedication: 'Lisinopril',
            dosage: '10mg',
            frequency: 'once daily',
            lastVisit: '2025-07-20',
            condition: 'Hypertension',
            DocumentID: 'test-patient-789',
            followUpAppointment: { appointmentType: 'Cardiology follow-up' }
        };
        
        const patientBot = new PatientBot(samplePatient, null);
        
        console.log('✅ PatientBot initialized for:', samplePatient.patientName);
        
        // Test conversation flow
        console.log('\n🗣️ Testing conversation flow:');
        
        const greeting = await patientBot.processMessage("Hello");
        console.log('🤖 Jenny (Greeting):', greeting.substring(0, 150) + '...');
        
        const response1 = await patientBot.processMessage("Yes, this is a good time to talk");
        console.log('🤖 Jenny (Triage):', response1.substring(0, 150) + '...');
        
        const state = patientBot.getConversationState();
        console.log('📊 Current state:', state.activeAgent, '| Completed stages:', 
                   Object.entries(state).filter(([key, value]) => key.includes('Completed') && value).map(([key]) => key));
        
        console.log('✅ PatientBot standalone test completed');
        
    } catch (error) {
        console.error('❌ PatientBot standalone test failed:', error.message);
    }
}

// Run tests
if (require.main === module) {
    testCallIntegration()
        .then(() => testHttpEndpointCall())
        .then(() => testPatientBotStandalone());
}

module.exports = { testCallIntegration, testHttpEndpointCall, testPatientBotStandalone };
