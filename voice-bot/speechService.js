// Enhanced Azure Speech Service integration for healthcare voice bot
// Optimized for medical terminology and patient conversations

const sdk = require('microsoft-cognitiveservices-speech-sdk');

class HealthcareSpeechService {
    constructor() {
        this.speechConfig = this.initializeSpeechConfig();
        this.medicalTerms = this.loadMedicalVocabulary();
    }

    initializeSpeechConfig() {
        const speechConfig = sdk.SpeechConfig.fromSubscription(
            process.env.AZURE_SPEECH_KEY,
            process.env.AZURE_SPEECH_REGION || 'eastus'
        );

        // Enhanced configuration for healthcare conversations
        speechConfig.speechRecognitionLanguage = "en-US";
        speechConfig.speechSynthesisVoiceName = "en-US-JennyNeural";
        
        // Set output format for high quality audio
        speechConfig.speechSynthesisOutputFormat = 
            sdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3;

        // Enable detailed result for better error handling
        speechConfig.enableDictation();
        
        return speechConfig;
    }

    loadMedicalVocabulary() {
        return [
            // Common medications
            "amoxicillin", "metformin", "ibuprofen", "acetaminophen", 
            "lisinopril", "atorvastatin", "omeprazole", "amlodipine",
            
            // Medical terms
            "prescription", "dosage", "milligrams", "medication", 
            "adherence", "side effects", "symptoms", "follow-up",
            
            // Healthcare actions
            "appointment", "scheduling", "triage", "consultation",
            "refill", "pharmacy", "insurance", "copay"
        ];
    }

    // Create speech recognizer with healthcare optimizations
    createSpeechRecognizer(audioConfig) {
        const recognizer = new sdk.SpeechRecognizer(this.speechConfig, audioConfig);
        
        // Add custom vocabulary for better medical term recognition
        const phraseList = sdk.PhraseListGrammar.fromRecognizer(recognizer);
        this.medicalTerms.forEach(term => phraseList.addPhrase(term));

        // Configure recognition parameters for patient conversations
        recognizer.properties.setProperty(
            sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, 
            "5000"
        );
        recognizer.properties.setProperty(
            sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, 
            "2000"
        );

        return recognizer;
    }

    // Create speech synthesizer with healthcare-optimized settings
    createSpeechSynthesizer(audioConfig) {
        return new sdk.SpeechSynthesizer(this.speechConfig, audioConfig);
    }

    // Generate SSML for different conversation contexts
    generateSSML(text, context = 'normal', voiceStyle = 'customerservice') {
        const voiceName = "en-US-JennyNeural";
        
        const contextSettings = {
            welcome: { rate: '0.9', pitch: 'medium', style: 'customerservice' },
            medication: { rate: '0.85', pitch: 'medium', style: 'empathetic' },
            appointment: { rate: '0.9', pitch: 'medium', style: 'customerservice' },
            emergency: { rate: '1.0', pitch: 'high', style: 'urgent' },
            normal: { rate: '0.9', pitch: 'medium', style: 'customerservice' }
        };

        const settings = contextSettings[context] || contextSettings.normal;
        
        // Enhance medication mentions with emphasis
        let enhancedText = text.replace(
            /(\d+)\s*(mg|milligrams?|tablets?|pills?)/gi, 
            '<emphasis level="moderate">$1 $2</emphasis>'
        );
        
        // Emphasize times and dates
        enhancedText = enhancedText.replace(
            /(\d{1,2}:\d{2}\s*(AM|PM))/gi, 
            '<emphasis level="strong">$1</emphasis>'
        );

        return `<speak version="1.0" xml:lang="en-US">
            <voice name="${voiceName}" style="${settings.style}" styledegree="0.8">
                <prosody rate="${settings.rate}" pitch="${settings.pitch}">
                    ${enhancedText}
                </prosody>
            </voice>
        </speak>`;
    }

    // Validate speech service configuration
    async validateConfiguration() {
        try {
            const synthesizer = this.createSpeechSynthesizer();
            const testSSML = this.generateSSML("Testing speech configuration", "normal");
            
            return new Promise((resolve, reject) => {
                synthesizer.speakSsmlAsync(
                    testSSML,
                    result => {
                        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                            console.log('[SpeechService] Configuration validated successfully');
                            resolve(true);
                        } else {
                            console.error('[SpeechService] Speech synthesis failed:', result.errorDetails);
                            reject(new Error(result.errorDetails));
                        }
                        synthesizer.close();
                    },
                    error => {
                        console.error('[SpeechService] Speech synthesis error:', error);
                        synthesizer.close();
                        reject(error);
                    }
                );
            });
        } catch (error) {
            console.error('[SpeechService] Configuration validation failed:', error);
            throw error;
        }
    }
}

module.exports = { HealthcareSpeechService };
