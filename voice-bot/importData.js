// importData.js
const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential } = require("@azure/identity");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// --- Configuration ---
// Use environment variables for sensitive configuration
const endpoint = process.env.COSMOS_DB_ENDPOINT || "https://voicebotcosmosdbaccount.documents.azure.com:443/";
const databaseId = process.env.COSMOS_DB_DATABASE || "HealthcareDB";
const containerId = process.env.COSMOS_DB_CONTAINER || "Patients";
const jsonFilePath = path.join(__dirname, "patients.json");

// Use Managed Identity when possible, fallback to connection string for development
const cosmosCredential = process.env.COSMOS_DB_CONNECTION_STRING 
    ? undefined 
    : new DefaultAzureCredential();

// --- Main Logic ---
async function importData() {
    console.log("Starting data import...");

    try {
        // 1. Connect to Azure Cosmos DB with proper authentication
        const clientOptions = cosmosCredential 
            ? { endpoint, aadCredentials: cosmosCredential }
            : { connectionString: process.env.COSMOS_DB_CONNECTION_STRING };
        
        const client = new CosmosClient(clientOptions);
        const database = client.database(databaseId);
        const container = database.container(containerId);

        // 2. Read the local JSON file
        if (!fs.existsSync(jsonFilePath)) {
            throw new Error(`Patient data file not found: ${jsonFilePath}`);
        }

        const patientData = JSON.parse(fs.readFileSync(jsonFilePath, "utf-8"));
        
        if (!Array.isArray(patientData) || patientData.length === 0) {
            throw new Error("No valid patient data found in the JSON file");
        }

        console.log(`Found ${patientData.length} patient records to import`);

        // 3. Upload each patient record with proper error handling and retry logic
        const uploadPromises = patientData.map(async (patient, index) => {
            const maxRetries = 3;
            let retryCount = 0;
            
            while (retryCount < maxRetries) {
                try {
                    console.log(`Uploading patient ${index + 1}/${patientData.length}: ${patient.patientName || 'Unknown'}`);
                    const result = await container.items.create(patient);
                    return result;
                } catch (error) {
                    retryCount++;
                    if (retryCount >= maxRetries) {
                        console.error(`Failed to upload patient ${patient.patientName || 'Unknown'} after ${maxRetries} attempts:`, error.message);
                        throw error;
                    }
                    
                    // Exponential backoff
                    const delay = Math.pow(2, retryCount) * 1000;
                    console.warn(`Retry ${retryCount}/${maxRetries} for patient ${patient.patientName || 'Unknown'} in ${delay}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        });

        // Wait for all uploads to complete
        const results = await Promise.allSettled(uploadPromises);
        
        const successful = results.filter(result => result.status === 'fulfilled').length;
        const failed = results.filter(result => result.status === 'rejected').length;

        console.log(`\nImport completed:`);
        console.log(`  Successfully imported: ${successful} documents`);
        console.log(`  Failed: ${failed} documents`);
        
        if (failed > 0) {
            console.error("\nFailed imports:");
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.error(`  Patient ${index + 1}: ${result.reason.message}`);
                }
            });
        }

    } catch (error) {
        console.error("Error during data import:", error.message);
        console.error("Stack trace:", error.stack);
        process.exit(1);
    }
}

importData().catch(error => {
    console.error("Error during data import:", error);
});