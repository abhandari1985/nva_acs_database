// updatePhoneNumbers.js
const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential } = require("@azure/identity");
require("dotenv").config();

// --- Configuration ---
// Use environment variables for sensitive configuration
const endpoint = process.env.COSMOS_DB_ENDPOINT || "https://voicebotcosmosdbaccount.documents.azure.com:443/";
const databaseId = process.env.COSMOS_DB_DATABASE || "HealthcareDB";
const containerId = process.env.COSMOS_DB_CONTAINER || "Patients";
const newPhoneNumber = "+918856866045";

// Use Managed Identity when possible, fallback to connection string for development
const cosmosCredential = process.env.COSMOS_DB_CONNECTION_STRING 
    ? undefined 
    : new DefaultAzureCredential();

// --- Main Logic ---
async function bulkUpdatePhoneNumbers() {
    console.log("Starting bulk update process...");

    try {
        // 1. Connect to Azure Cosmos DB with proper authentication
        const clientOptions = cosmosCredential 
            ? { endpoint, aadCredentials: cosmosCredential }
            : { connectionString: process.env.COSMOS_DB_CONNECTION_STRING };
        
        const client = new CosmosClient(clientOptions);
        const container = client.database(databaseId).container(containerId);

        // 2. Fetch all documents from the container
        console.log("Fetching all patient records...");
        const { resources: items } = await container.items.readAll().fetchAll();
        
        if (!items || items.length === 0) {
            console.log("No patient records found in the database.");
            return;
        }
        
        console.log(`Found ${items.length} records to update.`);

        // 3. Create an array of update operations with proper error handling
        const updatePromises = items.map(async (item, index) => {
            const maxRetries = 3;
            let retryCount = 0;
            
            while (retryCount < maxRetries) {
                try {
                    console.log(`Updating phone number for patient ${index + 1}/${items.length}: ${item.patientName || 'Unknown'} (ID: ${item.id})`);

                    // Modify the phoneNumber property
                    item.phoneNumber = newPhoneNumber;

                    // Replace the item directly (simpler than bulk operation for better error handling)
                    const { resource: updatedItem } = await container.item(item.id, item.DocumentID).replace(item);
                    return updatedItem;
                } catch (error) {
                    retryCount++;
                    if (retryCount >= maxRetries) {
                        console.error(`Failed to update patient ${item.patientName || 'Unknown'} after ${maxRetries} attempts:`, error.message);
                        throw error;
                    }
                    
                    // Exponential backoff
                    const delay = Math.pow(2, retryCount) * 1000;
                    console.warn(`Retry ${retryCount}/${maxRetries} for patient ${item.patientName || 'Unknown'} in ${delay}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        });

        // 4. Execute all operations and handle results
        console.log("\nExecuting bulk update...");
        const results = await Promise.allSettled(updatePromises);
        
        const successful = results.filter(result => result.status === 'fulfilled').length;
        const failed = results.filter(result => result.status === 'rejected').length;

        console.log(`\nUpdate completed:`);
        console.log(`  Successfully updated: ${successful} documents`);
        console.log(`  Failed: ${failed} documents`);
        
        if (failed > 0) {
            console.error("\nFailed updates:");
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.error(`  Patient ${index + 1}: ${result.reason.message}`);
                }
            });
        }

        console.log(`\nAll phone numbers have been updated to: ${newPhoneNumber}`);

    } catch (error) {
        console.error("Error during bulk update:", error.message);
        console.error("Stack trace:", error.stack);
        process.exit(1);
    }
}

bulkUpdatePhoneNumbers().catch(error => {
    console.error("An error occurred during the bulk update:", error);
});