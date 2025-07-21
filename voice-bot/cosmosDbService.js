// cosmosDbService.js
const { CosmosClient } = require("@azure/cosmos");
const { DefaultAzureCredential } = require("@azure/identity");
require("dotenv").config();

class CosmosDbService {
    constructor() {
        this.endpoint = process.env.COSMOS_DB_ENDPOINT || "https://voicebotcosmosdbaccount.documents.azure.com:443/";
        this.databaseId = process.env.COSMOS_DB_DATABASE || "HealthcareDB";
        this.containerId = process.env.COSMOS_DB_CONTAINER || "Patients";
        
        // Use Managed Identity when possible, fallback to connection string for development
        const cosmosCredential = process.env.COSMOS_DB_CONNECTION_STRING 
            ? undefined 
            : new DefaultAzureCredential();

        const clientOptions = cosmosCredential 
            ? { endpoint: this.endpoint, aadCredentials: cosmosCredential }
            : { connectionString: process.env.COSMOS_DB_CONNECTION_STRING };
        
        this.client = new CosmosClient(clientOptions);
        this.database = this.client.database(this.databaseId);
        this.container = this.database.container(this.containerId);
    }

    /**
     * Get patient by phone number
     * @param {string} phoneNumber - Patient's phone number
     * @returns {Promise<Object|null>} Patient data or null if not found
     */
    async getPatientByPhoneNumber(phoneNumber) {
        try {
            // Remove any formatting from phone number for consistent matching
            const cleanPhoneNumber = phoneNumber.replace(/[^\d+]/g, '');
            
            const querySpec = {
                query: "SELECT * FROM c WHERE c.phoneNumber = @phoneNumber",
                parameters: [{
                    name: "@phoneNumber",
                    value: cleanPhoneNumber
                }]
            };

            const { resources: patients } = await this.container.items
                .query(querySpec)
                .fetchAll();

            return patients.length > 0 ? patients[0] : null;
        } catch (error) {
            console.error("Error getting patient by phone number:", error);
            throw error;
        }
    }

    /**
     * Get patient by name
     * @param {string} patientName - Patient's name
     * @returns {Promise<Object|null>} Patient data or null if not found
     */
    async getPatientByName(patientName) {
        try {
            const querySpec = {
                query: "SELECT * FROM c WHERE UPPER(c.patientName) = UPPER(@patientName)",
                parameters: [{
                    name: "@patientName",
                    value: patientName
                }]
            };

            const { resources: patients } = await this.container.items
                .query(querySpec)
                .fetchAll();

            return patients.length > 0 ? patients[0] : null;
        } catch (error) {
            console.error("Error getting patient by name:", error);
            throw error;
        }
    }

    /**
     * Update patient's follow-up call information
     * @param {string} documentId - Patient's document ID
     * @param {Object} callData - Call data to update
     * @returns {Promise<Object>} Updated patient data
     */
    async updateFollowUpCall(documentId, callData) {
        try {
            const { resource: patient } = await this.container.item(documentId, documentId).read();
            
            if (!patient) {
                throw new Error(`Patient with ID ${documentId} not found`);
            }

            // Update follow-up call information
            patient.followUpCall = {
                ...patient.followUpCall,
                ...callData,
                callTimestamp: new Date().toISOString()
            };

            const { resource: updatedPatient } = await this.container
                .item(documentId, documentId)
                .replace(patient);

            return updatedPatient;
        } catch (error) {
            console.error("Error updating follow-up call:", error);
            throw error;
        }
    }

    /**
     * Update patient's medication adherence answers
     * @param {string} documentId - Patient's document ID
     * @param {Object} adherenceAnswers - Adherence answers
     * @returns {Promise<Object>} Updated patient data
     */
    async updateAdherenceAnswers(documentId, adherenceAnswers) {
        try {
            const { resource: patient } = await this.container.item(documentId, documentId).read();
            
            if (!patient) {
                throw new Error(`Patient with ID ${documentId} not found`);
            }

            // Update adherence answers
            patient.followUpCall.adherenceAnswers = {
                ...patient.followUpCall.adherenceAnswers,
                ...adherenceAnswers
            };

            const { resource: updatedPatient } = await this.container
                .item(documentId, documentId)
                .replace(patient);

            return updatedPatient;
        } catch (error) {
            console.error("Error updating adherence answers:", error);
            throw error;
        }
    }

    /**
     * Schedule follow-up appointment
     * @param {string} documentId - Patient's document ID
     * @param {Object} appointmentData - Appointment data
     * @returns {Promise<Object>} Updated patient data
     */
    async scheduleFollowUpAppointment(documentId, appointmentData) {
        try {
            const { resource: patient } = await this.container.item(documentId, documentId).read();
            
            if (!patient) {
                throw new Error(`Patient with ID ${documentId} not found`);
            }

            // Update follow-up appointment information
            patient.followUpAppointment = {
                ...patient.followUpAppointment,
                ...appointmentData,
                scheduled: true
            };

            const { resource: updatedPatient } = await this.container
                .item(documentId, documentId)
                .replace(patient);

            return updatedPatient;
        } catch (error) {
            console.error("Error scheduling follow-up appointment:", error);
            throw error;
        }
    }

    /**
     * Get patients who need follow-up calls
     * @returns {Promise<Array>} Array of patients needing follow-up
     */
    async getPatientsNeedingFollowUp() {
        try {
            const querySpec = {
                query: `
                    SELECT * FROM c 
                    WHERE c.followUpCall.callCompleted = false 
                    AND DateTimeDiff('day', c.dischargeDate, GetCurrentDateTime()) >= 1
                `,
                parameters: []
            };

            const { resources: patients } = await this.container.items
                .query(querySpec)
                .fetchAll();

            return patients;
        } catch (error) {
            console.error("Error getting patients needing follow-up:", error);
            throw error;
        }
    }

    /**
     * Mark follow-up call as completed
     * @param {string} documentId - Patient's document ID
     * @param {string} transcriptUrl - Optional transcript URL
     * @returns {Promise<Object>} Updated patient data
     */
    async markFollowUpCallCompleted(documentId, transcriptUrl = null) {
        try {
            const callData = {
                callCompleted: true,
                callTimestamp: new Date().toISOString(),
                callTranscriptUrl: transcriptUrl
            };

            return await this.updateFollowUpCall(documentId, callData);
        } catch (error) {
            console.error("Error marking follow-up call as completed:", error);
            throw error;
        }
    }

    /**
     * Update patient record with general data
     * @param {string} patientId - Patient's ID
     * @param {Object} updateData - Data to update
     * @returns {Promise<Object>} Updated patient data
     */
    async updatePatientRecord(patientId, updateData) {
        try {
            // First, get the current patient record to obtain the DocumentID for partitioning
            const patient = await this.getPatientById(patientId);
            if (!patient) {
                throw new Error(`Patient with ID ${patientId} not found`);
            }

            // Merge the update data with existing patient data
            const updatedPatient = { ...patient, ...updateData };

            const { resource: updatedItem } = await this.container
                .item(patientId, patient.DocumentID)
                .replace(updatedPatient);

            console.log(`Patient record updated successfully for ID: ${patientId}`);
            return updatedItem;
        } catch (error) {
            console.error("Error updating patient record:", error);
            throw error;
        }
    }

    /**
     * Get patient by ID
     * @param {string} patientId - Patient's ID
     * @returns {Promise<Object|null>} Patient data or null if not found
     */
    async getPatientById(patientId) {
        try {
            const querySpec = {
                query: "SELECT * FROM c WHERE c.id = @patientId",
                parameters: [{
                    name: "@patientId",
                    value: patientId
                }]
            };

            const { resources: patients } = await this.container.items
                .query(querySpec)
                .fetchAll();

            return patients.length > 0 ? patients[0] : null;
        } catch (error) {
            console.error("Error getting patient by ID:", error);
            throw error;
        }
    }
}

module.exports = CosmosDbService;
