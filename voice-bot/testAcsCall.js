const { CallAutomationClient } = require('@azure/communication-call-automation');
require('dotenv').config();

async function testAcsCall() {
    try {
        console.log('🧪 Testing ACS International Call Setup...\n');
        
        // Test data with your Indian phone number
        const callData = {
            phoneNumber: "+919158066045", // Your Indian number
            patientName: "Test Patient",
            doctorName: "Dr. Test",
            medications: [{ medicationName: "Test Med", dosage: "10mg" }]
        };
        
        console.log('📋 Call Details:');
        console.log(`  📞 From: ${process.env.ACS_PHONE_NUMBER} (US ACS Number)`);
        console.log(`  📞 To: ${callData.phoneNumber} (Indian Number)`);
        console.log(`  👤 Patient: ${callData.patientName}`);
        console.log(`  🩺 Doctor: Dr. ${callData.doctorName}\n`);
        
        if (!process.env.ACS_CONNECTION_STRING) {
            console.error('❌ ACS_CONNECTION_STRING is missing. Cannot proceed.');
            return;
        }
        
        console.log('🚀 Initiating test call...');
        
        // Initialize ACS client directly (like diagnoseAcs.js)
        const callClient = new CallAutomationClient(process.env.ACS_CONNECTION_STRING);
        
        // Create the call invite
        const callInvite = {
            targetParticipant: {
                kind: 'phoneNumber',
                phoneNumber: callData.phoneNumber
            },
            sourceCallIdNumber: {
                kind: 'phoneNumber', 
                phoneNumber: process.env.ACS_PHONE_NUMBER
            }
        };
        
        console.log('📋 Call Configuration:');
        console.log(`   From: ${process.env.ACS_PHONE_NUMBER}`);
        console.log(`   To: ${callData.phoneNumber}`);
        console.log(`   Callback URL: ${process.env.ACS_CALLBACK_URL}\n`);
        
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
        
        console.log('✅ Call Response: Call initiated successfully!');
        console.log('📞 Call Connection ID:', createCallResult.callConnection.callConnectionId);
        console.log('\n🎉 What should happen:');
        console.log('1. Your Indian phone (+919158066045) should ring');
        console.log('2. The call is from US number +18667759336');
        console.log('3. You should hear the healthcare assistant greeting');
        console.log('4. International calling rates apply');
        console.log('\n💡 Monitor the voice server logs for ACS events!');
        
    } catch (error) {
        console.error('❌ Test call failed:', error.message);
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
        
        console.log('\n🔧 Basic Troubleshooting:');
        console.log('1. Ensure voice server is running: npm run start:voice');
        console.log('2. Ensure Dev Tunnel is active');
        console.log('3. Check ACS account has international calling enabled');
        console.log('4. Verify phone number format: +919158066045');
    }
}

testAcsCall();
