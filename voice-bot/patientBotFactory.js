// Healthcare Voice Agent - Patient Data Loader and Bot Factory
// This file handles loading patient data from Cosmos DB and creating personalized bot instances

const fs = require('fs');
const path = require('path');
const { EchoBot } = require('./bot');
const CosmosDbService = require('./cosmosDbService');

class PatientBotFactory {
    constructor() {
        this.cosmosDbService = new CosmosDbService();
        this.patientsFilePath = path.join(__dirname, 'patients.json');
        // Keep local fallback for development
        this.localPatientsData = this.loadLocalPatientData();
        console.log('[Factory] PatientBotFactory initialized with Cosmos DB integration');
    }

    // Load local patient data as fallback
    loadLocalPatientData() {
        try {
            const data = fs.readFileSync(this.patientsFilePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            console.warn('[Factory] Could not load local patient data (this is normal in production):', error.message);
            return [];
        }
    }

    // Get all patients who need follow-up calls (from Cosmos DB)
    async getPatientsNeedingCalls() {
        try {
            return await this.cosmosDbService.getPatientsNeedingFollowUp();
        } catch (error) {
            console.error('[Factory] Error getting patients from Cosmos DB, falling back to local data:', error.message);
            return this.localPatientsData.filter(patient => 
                !patient.followUpCall.callCompleted && 
                !patient.followUpCall.callInitiated
            );
        }
    }

    // Get a specific patient by DocumentID (from Cosmos DB)
    async getPatientById(documentId) {
        try {
            const { resource: patient } = await this.cosmosDbService.container.item(documentId, documentId).read();
            return patient;
        } catch (error) {
            console.error('[Factory] Error getting patient by ID from Cosmos DB:', error.message);
            return this.localPatientsData.find(patient => patient.DocumentID === documentId);
        }
    }

    // Get patient by phone number (useful for incoming calls)
    async getPatientByPhoneNumber(phoneNumber) {
        try {
            return await this.cosmosDbService.getPatientByPhoneNumber(phoneNumber);
        } catch (error) {
            console.error('[Factory] Error getting patient by phone number from Cosmos DB:', error.message);
            const cleanPhoneNumber = phoneNumber.replace(/[^\d+]/g, '');
            return this.localPatientsData.find(patient => patient.phoneNumber === cleanPhoneNumber);
        }
    }

    // Get patient by name
    async getPatientByName(patientName) {
        try {
            return await this.cosmosDbService.getPatientByName(patientName);
        } catch (error) {
            console.error('[Factory] Error getting patient by name from Cosmos DB:', error.message);
            return this.localPatientsData.find(patient => 
                patient.patientName.toLowerCase().includes(patientName.toLowerCase())
            );
        }
    }

    // Create a bot instance for a specific patient
    createBotForPatient(patientRecord) {
        if (!patientRecord) {
            throw new Error('Patient record is required');
        }

        console.log(`[Factory] Creating bot for patient: ${patientRecord.patientName} (${patientRecord.DocumentID})`);
        
        // Create enhanced bot with Cosmos DB integration
        const bot = new EchoBot(patientRecord);
        
        // Add Cosmos DB service to bot for data updates
        bot.cosmosDbService = this.cosmosDbService;
        
        return bot;
    }

    // Get the next patient who needs a call (for demo purposes)
    async getNextPatientForCall() {
        try {
            const patientsNeeding = await this.getPatientsNeedingCalls();
            if (patientsNeeding.length === 0) {
                console.log('[Factory] No patients currently need follow-up calls');
                return null;
            }
            
            // Return the first patient who needs a call
            return patientsNeeding[0];
        } catch (error) {
            console.error('[Factory] Error getting next patient for call:', error.message);
            return null;
        }
    }

    // Simulate selecting a patient for calling (for demo/testing)
    async selectPatientForDemo(patientName = null) {
        try {
            if (patientName) {
                const patient = await this.getPatientByName(patientName);
                if (patient) {
                    console.log(`[Factory] Selected patient: ${patient.patientName} for demo`);
                    return patient;
                }
            }
            
            // Default to first patient for demo
            const patientsNeeding = await this.getPatientsNeedingCalls();
            if (patientsNeeding.length > 0) {
                const demoPatient = patientsNeeding[0];
                console.log(`[Factory] Using demo patient: ${demoPatient.patientName}`);
                return demoPatient;
            }
            
            // Fallback to local data
            const demoPatient = this.localPatientsData[0];
            console.log(`[Factory] Using fallback demo patient: ${demoPatient?.patientName || 'None available'}`);
            return demoPatient;
        } catch (error) {
            console.error('[Factory] Error selecting patient for demo:', error.message);
            return this.localPatientsData[0] || null;
        }
    }

    // Get patient statistics (with Cosmos DB integration)
    async getPatientStats() {
        try {
            const patientsNeeding = await this.getPatientsNeedingCalls();
            
            // For more detailed stats, we might need additional queries
            // For now, return basic stats based on patients needing calls
            return {
                total: 'Cosmos DB connected',
                callsCompleted: 'Dynamic from DB',
                callsInitiated: 'Dynamic from DB', 
                callsPending: patientsNeeding.length,
                appointmentsScheduled: 'Dynamic from DB'
            };
        } catch (error) {
            console.error('[Factory] Error getting patient stats from Cosmos DB:', error.message);
            
            // Fallback to local data stats
            const total = this.localPatientsData.length;
            const callsCompleted = this.localPatientsData.filter(p => p.followUpCall.callCompleted).length;
            const callsInitiated = this.localPatientsData.filter(p => p.followUpCall.callInitiated && !p.followUpCall.callCompleted).length;
            const callsPending = this.localPatientsData.filter(p => !p.followUpCall.callInitiated).length;
            
            return {
                total,
                callsCompleted,
                callsInitiated,
                callsPending,
                appointmentsScheduled: this.localPatientsData.filter(p => p.followUpAppointment.scheduled).length
            };
        }
    }

    // Update patient data in Cosmos DB after call completion
    async updatePatientAfterCall(documentId, callData, adherenceAnswers = null, appointmentData = null) {
        try {
            // Mark call as completed
            await this.cosmosDbService.markFollowUpCallCompleted(documentId, callData.transcriptUrl);
            
            // Update adherence answers if provided
            if (adherenceAnswers) {
                await this.cosmosDbService.updateAdherenceAnswers(documentId, adherenceAnswers);
            }
            
            // Schedule appointment if data provided
            if (appointmentData) {
                await this.cosmosDbService.scheduleFollowUpAppointment(documentId, appointmentData);
            }
            
            console.log(`[Factory] Successfully updated patient ${documentId} in Cosmos DB`);
            return true;
        } catch (error) {
            console.error('[Factory] Error updating patient in Cosmos DB:', error.message);
            return false;
        }
    }
}

// Export the factory for use in your main application
module.exports = { PatientBotFactory };

// Example usage for testing/demo (uncomment to test)
/*
if (require.main === module) {
    const factory = new PatientBotFactory();

    // Show statistics
    console.log('\n=== Patient Statistics ===');
    console.log(factory.getPatientStats());

    // Get next patient for call
    const patientForCall = factory.getNextPatientForCall();
    if (patientForCall) {
        console.log(`\n=== Next Patient for Call ===`);
        console.log(`Name: ${patientForCall.patientName}`);
        console.log(`Doctor: Dr. ${patientForCall.doctorName}`);
        console.log(`Medication: ${patientForCall.prescriptions[0].medicationName} ${patientForCall.prescriptions[0].dosage}`);

        // Create bot for this patient
        const bot = factory.createBotForPatient(patientForCall);
        console.log(`Bot created successfully for ${patientForCall.patientName}`);
    }
}
*/
