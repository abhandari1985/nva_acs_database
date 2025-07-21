const { CosmosClient } = require('@azure/cosmos');
require('dotenv').config();

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database(process.env.COSMOS_DB_DATABASE);
const container = database.container(process.env.COSMOS_DB_CONTAINER);

async function checkDatabase() {
  try {
    console.log('🔍 Checking database contents...');
    
    // Get all patients
    const allPatientsQuery = {
      query: 'SELECT * FROM c'
    };
    
    const { resources: allPatients } = await container.items.query(allPatientsQuery).fetchAll();
    console.log(`\n📊 Total patients in database: ${allPatients.length}`);
    
    if (allPatients.length > 0) {
      console.log('\n📋 Patient data structure:');
      console.log(JSON.stringify(allPatients[0], null, 2));
      
      // Check if any have phone numbers
      const patientsWithPhone = allPatients.filter(p => p.phone || p.phoneNumber || p.Phone);
      console.log(`\n📞 Patients with phone numbers: ${patientsWithPhone.length}`);
      
      if (patientsWithPhone.length === 0) {
        console.log('\n⚠️  No patients have phone numbers. Let me add a test patient...');
        
        // Add a test patient with phone number
        const testPatient = {
          id: `test-patient-${Date.now()}`,
          firstName: "Test",
          lastName: "Patient", 
          phone: "+15551234567", // Test phone number - replace with yours for testing
          doctor: "Dr. Smith",
          lastVisit: "2025-07-15",
          needsFollowUp: true,
          condition: "Post-surgery follow-up",
          notes: "Patient needs follow-up call for recovery check"
        };
        
        await container.items.create(testPatient);
        console.log('✅ Added test patient:');
        console.log(JSON.stringify(testPatient, null, 2));
        
        console.log(`\n🎯 TEST CALL COMMAND:`);
        console.log(`curl -X POST http://localhost:3979/api/trigger-call -H "Content-Type: application/json" -d '{"phoneNumber": "${testPatient.phone}"}'`);
      }
    } else {
      console.log('\n⚠️  Database is empty! Let me add sample patients...');
      
      const samplePatients = [
        {
          id: `patient-001-${Date.now()}`,
          firstName: "John",
          lastName: "Doe",
          phone: "+15551234567", // Replace with your phone number for testing
          doctor: "Dr. Smith",
          lastVisit: "2025-07-15",
          needsFollowUp: true,
          condition: "Diabetes follow-up",
          notes: "Patient needs medication adherence check"
        },
        {
          id: `patient-002-${Date.now()}`,
          firstName: "Jane",
          lastName: "Smith", 
          phone: "+15559876543", // Replace with your phone number for testing
          doctor: "Dr. Johnson",
          lastVisit: "2025-07-10",
          needsFollowUp: true,
          condition: "Hypertension monitoring",
          notes: "Check blood pressure readings"
        }
      ];
      
      for (const patient of samplePatients) {
        await container.items.create(patient);
        console.log(`✅ Added patient: ${patient.firstName} ${patient.lastName}`);
      }
      
      console.log(`\n🎯 TEST CALL COMMANDS:`);
      samplePatients.forEach((patient, index) => {
        console.log(`${index + 1}. curl -X POST http://localhost:3979/api/trigger-call -H "Content-Type: application/json" -d '{"phoneNumber": "${patient.phone}"}'`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

checkDatabase();
