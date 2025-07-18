targetScope = 'resourceGroup'

@minLength(1)
@maxLength(64)
@description('Name of the environment that can be used as part of naming resource convention')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

// Optional parameters for existing resources
param appServicePlanName string = ''

// Healthcare Voice Agent specific parameters
@secure()
param microsoftAppId string = ''
@secure()
param microsoftAppPassword string = ''
@secure()
param azureOpenAiEndpoint string = ''
@secure()
param azureOpenAiKey string = ''
@secure()
param azureOpenAiDeploymentName string = ''
@secure()
param azureSpeechKey string = ''
@secure()
param azureSpeechRegion string = ''
@secure()
param graphClientId string = ''
@secure()
param graphTenantId string = ''
@secure()
param graphClientSecret string = ''
@secure()
param graphUserId string = ''
@secure()
param schedulerAgentEmail string = ''

// Generate a unique token to be used in naming resources
var resourceToken = toLower(uniqueString(subscription().id, resourceGroup().id, environmentName))

// Tags that should be applied to all resources
var tags = {
  'azd-env-name': environmentName
}

var prefix = '${environmentName}-${resourceToken}'

// Organize resources in a consistent naming convention
var resourceNames = {
  appServicePlan: '${take(prefix, 40)}-plan'
  appService: '${take(prefix, 45)}-app'
  logAnalyticsWorkspace: '${take(prefix, 55)}-log'
  applicationInsights: '${take(prefix, 50)}-ai'
  keyVault: '${take(prefix, 21)}-kv'
  cognitiveServices: '${take(prefix, 45)}-cog'
  speechService: '${take(prefix, 50)}-speech'
  managedIdentity: '${take(prefix, 50)}-id'
}

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: resourceNames.logAnalyticsWorkspace
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: resourceNames.applicationInsights
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: resourceNames.managedIdentity
  location: location
  tags: tags
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: resourceNames.keyVault
  location: location
  tags: tags
  properties: {
    enabledForDeployment: true
    enabledForTemplateDeployment: true
    enabledForDiskEncryption: true
    tenantId: subscription().tenantId
    accessPolicies: []
    sku: {
      name: 'standard'
      family: 'A'
    }
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: !empty(appServicePlanName) ? appServicePlanName : resourceNames.appServicePlan
  location: location
  tags: tags
  sku: {
    name: 'B1'
    tier: 'Basic'
    capacity: 1
  }
  properties: {
    reserved: false
  }
}

resource appService 'Microsoft.Web/sites@2024-04-01' = {
  name: resourceNames.appService
  location: location
  tags: union(tags, { 'azd-service-name': 'voice-bot-backend' })
  kind: 'app'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: ''
      alwaysOn: true
      ftpsState: 'FtpsOnly'
      minTlsVersion: '1.2'
      appSettings: [
        {
          name: 'WEBSITES_NODE_DEFAULT_VERSION'
          value: '18-lts'
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: applicationInsights.properties.ConnectionString
        }
        {
          name: 'ApplicationInsightsAgent_EXTENSION_VERSION'
          value: '~3'
        }
        {
          name: 'MicrosoftAppId'
          value: microsoftAppId
        }
        {
          name: 'MicrosoftAppPassword'
          value: microsoftAppPassword
        }
        {
          name: 'AZURE_OPENAI_ENDPOINT'
          value: azureOpenAiEndpoint
        }
        {
          name: 'AZURE_OPENAI_KEY'
          value: azureOpenAiKey
        }
        {
          name: 'AZURE_OPENAI_DEPLOYMENT_NAME'
          value: azureOpenAiDeploymentName
        }
        {
          name: 'AZURE_SPEECH_KEY'
          value: azureSpeechKey
        }
        {
          name: 'AZURE_SPEECH_REGION'
          value: azureSpeechRegion
        }
        {
          name: 'GRAPH_CLIENT_ID'
          value: graphClientId
        }
        {
          name: 'GRAPH_TENANT_ID'
          value: graphTenantId
        }
        {
          name: 'GRAPH_CLIENT_SECRET'
          value: graphClientSecret
        }
        {
          name: 'GRAPH_USER_ID'
          value: graphUserId
        }
        {
          name: 'SCHEDULER_AGENT_EMAIL'
          value: schedulerAgentEmail
        }
      ]
      cors: {
        allowedOrigins: ['*']
        supportCredentials: false
      }
    }
  }
}

// App Service Site Extension for Bot Framework
resource botFrameworkExtension 'Microsoft.Web/sites/siteextensions@2024-04-01' = {
  parent: appService
  name: 'botframework-emulator'
}

// Outputs
output APPLICATIONINSIGHTS_CONNECTION_STRING string = applicationInsights.properties.ConnectionString
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = subscription().tenantId
output AZURE_KEY_VAULT_ENDPOINT string = keyVault.properties.vaultUri
output AZURE_KEY_VAULT_NAME string = keyVault.name
output RESOURCE_GROUP_ID string = resourceGroup().id
output SERVICE_VOICE_BOT_BACKEND_ENDPOINT_URL string = 'https://${appService.properties.defaultHostName}'
output SERVICE_VOICE_BOT_BACKEND_NAME string = appService.name
output SERVICE_VOICE_BOT_BACKEND_URI string = 'https://${appService.properties.defaultHostName}'
