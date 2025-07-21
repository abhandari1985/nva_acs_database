const axios = require('axios');

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
        console.log(`  📞 From: +18667759336 (US ACS Number)`);
        console.log(`  📞 To: ${callData.phoneNumber} (Indian Number)`);
        console.log(`  👤 Patient: ${callData.patientName}`);
        console.log(`  🩺 Doctor: Dr. ${callData.doctorName}\n`);
        
        console.log('🚀 Initiating test call...');
        
        const response = await axios.post('https://7xkq0gtv-3979.inc1.devtunnels.ms/api/trigger-call', callData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });
        
        console.log('✅ Call Response:', response.data);
        console.log('\n🎉 What should happen:');
        console.log('1. Your Indian phone (+919158066045) should ring');
        console.log('2. The call is from US number +18667759336');
        console.log('3. You should hear the healthcare assistant greeting');
        console.log('4. International calling rates apply');
        console.log('\n💡 Monitor the voice server logs for ACS events!');
        
    } catch (error) {
        console.error('❌ Test call failed:', error.message);
        
        if (error.response) {
            console.log('📝 Error details:', error.response.data);
        }
        
        console.log('\n🔧 Troubleshooting:');
        console.log('1. Ensure voice server is running: npm run start:voice');
        console.log('2. Ensure Dev Tunnel is active');
        console.log('3. Check ACS account has international calling enabled');
        console.log('4. Verify phone number format: +919158066045');
    }
}

testAcsCall();
