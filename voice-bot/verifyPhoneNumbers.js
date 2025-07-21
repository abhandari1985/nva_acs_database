// verifyPhoneNumbers.js
// Script to verify that all phone numbers have been updated correctly

const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential } = require("@azure/identity");
require("dotenv").config();

// --- Configuration ---
// Use environment variables for sensitive configuration
const endpoint = process.env.COSMOS_DB_ENDPOINT || "https://voicebotcosmosdbaccount.documents.azure.com:443/";
const databaseId = process.env.COSMOS_DB_DATABASE || "HealthcareDB";
const containerId = process.env.COSMOS_DB_CONTAINER || "Patients";
const expectedPhoneNumber = "+918856866045";

// Use Managed Identity when possible, fallback to connection string for development
const cosmosCredential = process.env.COSMOS_DB_CONNECTION_STRING 
    ? undefined 
    : new DefaultAzureCredential();

// --- Main Logic ---
async function verifyPhoneNumbers() {
    console.log("🔍 Verifying phone number updates...\n");

    try {
        // 1. Connect to Azure Cosmos DB with proper authentication
        const clientOptions = cosmosCredential 
            ? { endpoint, aadCredentials: cosmosCredential }
            : { connectionString: process.env.COSMOS_DB_CONNECTION_STRING };
        
        const client = new CosmosClient(clientOptions);
        const container = client.database(databaseId).container(containerId);

        // 2. Fetch all documents from the container
        console.log("📋 Fetching all patient records...");
        const { resources: items } = await container.items.readAll().fetchAll();
        
        if (!items || items.length === 0) {
            console.log("❌ No patient records found in the database.");
            return;
        }
        
        console.log(`✅ Found ${items.length} patient records\n`);

        // 3. Check each patient's phone number
        let correctPhoneNumbers = 0;
        let incorrectPhoneNumbers = 0;
        
        console.log("📞 Phone Number Verification Results:");
        console.log("=====================================");
        
        items.forEach((item, index) => {
            const patientName = item.patientName || 'Unknown';
            const phoneNumber = item.phoneNumber || 'Not set';
            const isCorrect = phoneNumber === expectedPhoneNumber;
            
            const status = isCorrect ? '✅' : '❌';
            console.log(`${String(index + 1).padStart(2)}. ${status} ${patientName.padEnd(20)} | ${phoneNumber}`);
            
            if (isCorrect) {
                correctPhoneNumbers++;
            } else {
                incorrectPhoneNumbers++;
            }
        });

        // 4. Summary
        console.log("\n📊 Summary:");
        console.log("===========");
        console.log(`Total patients: ${items.length}`);
        console.log(`Correct phone numbers: ${correctPhoneNumbers}`);
        console.log(`Incorrect phone numbers: ${incorrectPhoneNumbers}`);
        console.log(`Expected phone number: ${expectedPhoneNumber}`);
        
        if (incorrectPhoneNumbers === 0) {
            console.log("\n🎉 All phone numbers have been successfully updated!");
        } else {
            console.log(`\n⚠️  ${incorrectPhoneNumbers} phone numbers still need to be updated.`);
        }

    } catch (error) {
        console.error("❌ Error during verification:", error.message);
        console.error("Stack trace:", error.stack);
        process.exit(1);
    }
}

verifyPhoneNumbers().catch(error => {
    console.error("❌ Verification failed:", error);
});

module.exports = { verifyPhoneNumbers };
