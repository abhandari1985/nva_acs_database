const { CosmosClient } = require('@azure/cosmos');
require('dotenv').config();

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database(process.env.COSMOS_DB_DATABASE);
const container = database.container(process.env.COSMOS_DB_CONTAINER);

async function showPatientsForCalling() {
  try {
    console.log('🔍 Getting patients ready for follow-up calls...');
    
    const querySpec = {
      query: 'SELECT * FROM c WHERE c.phoneNumber != null AND c.followUpCall.callCompleted = false'
    };
    
    const { resources: patients } = await container.items.query(querySpec).fetchAll();
    
    console.log(`\n📊 Found ${patients.length} patients needing follow-up calls:\n`);
    
    patients.forEach((patient, index) => {
      console.log(`${index + 1}. ${patient.patientName}`);
      console.log(`   📞 Phone: ${patient.phoneNumber}`);
      console.log(`   🩺 Doctor: Dr. ${patient.doctorName}`);
      console.log(`   📅 Discharge: ${patient.dischargeDate}`);
      console.log(`   💊 Medications: ${patient.prescriptions.map(p => p.medicationName).join(', ')}`);
      console.log(`   📞 Call Status: ${patient.followUpCall.callCompleted ? 'Completed' : 'Pending'}`);
      console.log('   ─────────────────────────────────');
    });
    
    if (patients.length > 0) {
      const testPatient = patients[0];
      console.log(`\n🎯 RECOMMENDED TEST PATIENT:`);
      console.log(`Name: ${testPatient.patientName}`);
      console.log(`Phone: ${testPatient.phoneNumber}`);
      console.log(`Doctor: Dr. ${testPatient.doctorName}`);
      console.log(`Medications: ${testPatient.prescriptions.map(p => `${p.medicationName} ${p.dosage}`).join(', ')}`);
      
      console.log(`\n📞 TO MAKE A TEST CALL:`);
      console.log(`\n1. Make sure your voice server is running:`);
      console.log(`   npm run start:voice`);
      console.log(`\n2. Make sure Dev Tunnel is running:`);
      console.log(`   devtunnel host majestic-chair-h8rkp1d.inc1`);
      console.log(`\n3. Trigger the call (LOCAL):`);
      console.log(`   curl -X POST http://localhost:3979/api/trigger-call -H "Content-Type: application/json" -d '{"phoneNumber": "${testPatient.phoneNumber}"}'`);
      console.log(`\n4. Or via Dev Tunnel (RECOMMENDED for ACS):`);
      console.log(`   curl -X POST https://ks4mqb43-3979.inc1.devtunnels.ms/api/trigger-call -H "Content-Type: application/json" -d '{"phoneNumber": "${testPatient.phoneNumber}"}'`);
      
      console.log(`\n⚠️  IMPORTANT: Replace ${testPatient.phoneNumber} with YOUR phone number for testing!`);
      console.log(`   The Indian number might not work for ACS outbound calling from US region.`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

showPatientsForCalling();
