// testCosmosIntegration.js
// Test script to verify Cosmos DB integration with the voice bot

const { PatientBotFactory } = require('./patientBotFactory');
require('dotenv').config();

async function testCosmosIntegration() {
    console.log('🔄 Testing Cosmos DB Integration...\n');

    try {
        // Initialize the patient factory with Cosmos DB
        const patientFactory = new PatientBotFactory();
        console.log('✅ PatientBotFactory initialized\n');

        // Test 1: Get patients needing follow-up calls
        console.log('📋 Test 1: Getting patients needing follow-up calls...');
        const patientsNeeding = await patientFactory.getPatientsNeedingCalls();
        console.log(`✅ Found ${patientsNeeding.length} patients needing follow-up calls`);
        
        if (patientsNeeding.length > 0) {
            console.log(`   First patient: ${patientsNeeding[0].patientName} (${patientsNeeding[0].DocumentID})`);
        }
        console.log('');

        // Test 2: Get patient statistics
        console.log('📊 Test 2: Getting patient statistics...');
        const stats = await patientFactory.getPatientStats();
        console.log('✅ Patient statistics:', stats);
        console.log('');

        // Test 3: Get a specific patient for demo
        console.log('👤 Test 3: Getting demo patient...');
        const demoPatient = await patientFactory.selectPatientForDemo();
        if (demoPatient) {
            console.log(`✅ Demo patient: ${demoPatient.patientName}`);
            console.log(`   Doctor: Dr. ${demoPatient.doctorName}`);
            console.log(`   Medication: ${demoPatient.prescriptions[0]?.medicationName || 'N/A'}`);
            console.log(`   Phone: ${demoPatient.phoneNumber}`);
        } else {
            console.log('⚠️  No demo patient available');
        }
        console.log('');

        // Test 4: Test patient lookup by phone number
        if (demoPatient && demoPatient.phoneNumber) {
            console.log('📞 Test 4: Testing patient lookup by phone number...');
            const patientByPhone = await patientFactory.getPatientByPhoneNumber(demoPatient.phoneNumber);
            if (patientByPhone) {
                console.log(`✅ Found patient by phone: ${patientByPhone.patientName}`);
            } else {
                console.log('⚠️  Patient not found by phone number');
            }
            console.log('');
        }

        // Test 5: Create a bot instance
        if (demoPatient) {
            console.log('🤖 Test 5: Creating bot instance...');
            const bot = patientFactory.createBotForPatient(demoPatient);
            console.log(`✅ Bot created for patient: ${demoPatient.patientName}`);
            console.log(`   Bot has Cosmos DB service: ${bot.cosmosDbService ? 'Yes' : 'No'}`);
        }
        console.log('');

        console.log('🎉 All tests completed successfully!');
        console.log('\n📝 Next steps:');
        console.log('   1. Set your COSMOS_DB_CONNECTION_STRING in .env file');
        console.log('   2. Run the voice bot: npm start');
        console.log('   3. Test voice interactions with real patient data from Cosmos DB');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('\n🔧 Troubleshooting:');
        console.error('   1. Check your .env file has COSMOS_DB_ENDPOINT and COSMOS_DB_CONNECTION_STRING');
        console.error('   2. Verify Cosmos DB connection and credentials');
        console.error('   3. Ensure the HealthcareDB database and Patients container exist');
        console.error('   4. Run importData.js first to populate the database');
    }
}

// Run the test
if (require.main === module) {
    testCosmosIntegration();
}

module.exports = { testCosmosIntegration };
