// Healthcare Voice Agent - Patient Data Loader and Bot Factory
// This file handles loading patient data and creating personalized bot instances

const fs = require('fs');
const path = require('path');
const { EchoBot } = require('./bot');

class PatientBotFactory {
    constructor() {
        this.patientsFilePath = path.join(__dirname, 'patients.json');
        this.patientsData = this.loadPatientData();
    }

    loadPatientData() {
        try {
            const data = fs.readFileSync(this.patientsFilePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            console.error('[Factory] Error loading patient data:', error.message);
            throw new Error('Failed to load patient data');
        }
    }

    // Get all patients who need follow-up calls
    getPatientsNeedingCalls() {
        return this.patientsData.filter(patient => 
            !patient.followUpCall.callCompleted && 
            !patient.followUpCall.callInitiated
        );
    }

    // Get a specific patient by DocumentID
    getPatientById(documentId) {
        return this.patientsData.find(patient => patient.DocumentID === documentId);
    }

    // Create a bot instance for a specific patient
    createBotForPatient(patientRecord) {
        if (!patientRecord) {
            throw new Error('Patient record is required');
        }
        
        console.log(`[Factory] Creating bot for patient: ${patientRecord.patientName} (${patientRecord.DocumentID})`);
        return new EchoBot(patientRecord);
    }

    // Get the next patient who needs a call (for demo purposes)
    getNextPatientForCall() {
        const patientsNeeding = this.getPatientsNeedingCalls();
        if (patientsNeeding.length === 0) {
            console.log('[Factory] No patients currently need follow-up calls');
            return null;
        }
        
        // Return the first patient who needs a call
        return patientsNeeding[0];
    }

    // Simulate selecting a patient for calling (for demo/testing)
    selectPatientForDemo(patientName = null) {
        if (patientName) {
            const patient = this.patientsData.find(p => 
                p.patientName.toLowerCase().includes(patientName.toLowerCase())
            );
            if (patient) {
                console.log(`[Factory] Selected patient: ${patient.patientName} for demo`);
                return patient;
            }
        }
        
        // Default to first patient for demo
        const demoPatient = this.patientsData[0];
        console.log(`[Factory] Using demo patient: ${demoPatient.patientName}`);
        return demoPatient;
    }

    // Get patient statistics
    getPatientStats() {
        const total = this.patientsData.length;
        const callsCompleted = this.patientsData.filter(p => p.followUpCall.callCompleted).length;
        const callsInitiated = this.patientsData.filter(p => p.followUpCall.callInitiated && !p.followUpCall.callCompleted).length;
        const callsPending = this.patientsData.filter(p => !p.followUpCall.callInitiated).length;
        
        return {
            total,
            callsCompleted,
            callsInitiated,
            callsPending,
            appointmentsScheduled: this.patientsData.filter(p => p.followUpAppointment.scheduled).length
        };
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
