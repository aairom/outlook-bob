# IBM Cloud Container Registry Authentication

## Authentication Status Check

The current IBM Cloud CLI status returned:

```bash
ibmcloud target
```

Output:

```text
API endpoint: https://cloud.ibm.com
Region: eu-de
Not logged in. Use 'ibmcloud login' to log in.
```

This means you must authenticate to IBM Cloud first.

## 1. Log in to IBM Cloud

Use one of the following commands:

```bash
ibmcloud login --sso
```

Or with an API key:

```bash
ibmcloud login --apikey <your-api-key>
```

Verify the login:

```bash
ibmcloud target
```

## 2. Target the Correct Region

IBM Cloud Container Registry is regional. Example:

```bash
ibmcloud target -r eu-de
```

Common registry endpoints:

- `us.icr.io`
- `eu.icr.io`
- `uk.icr.io`
- `jp.icr.io`
- `au.icr.io`

## 3. Install the Container Registry Plugin

Check installed plugins:

```bash
ibmcloud plugin list
```

Install the plugin if needed:

```bash
ibmcloud plugin install container-registry
```

## 4. Authenticate Docker to IBM Cloud Container Registry

Set the registry region if needed:

```bash
ibmcloud cr region-set eu-central
```

Then log in:

```bash
ibmcloud cr login
```

This configures your local Docker client to authenticate against IBM Cloud Container Registry.

## 5. Verify Registry Access

List namespaces:

```bash
ibmcloud cr namespaces
```

Create a namespace if you do not already have one:

```bash
ibmcloud cr namespace-add my-namespace
```

## 6. API Key Authentication for CI/CD

For non-interactive authentication, log in directly with Docker:

```bash
docker login -u iamapikey -p <your-api-key> eu.icr.io
```

Replace `eu.icr.io` with your registry endpoint.

## 7. Code Engine Private Registry Authentication

If Code Engine must pull a private image, create a registry secret:

```bash
ibmcloud ce registry create --name my-registry-secret \
  --server eu.icr.io \
  --username iamapikey \
  --password <your-api-key>
```

Use the registry secret during deployment:

```bash
ibmcloud ce application create --name my-app \
  --image eu.icr.io/my-namespace/my-image:latest \
  --registry-secret my-registry-secret
```

## Security Notes

- Do not hardcode API keys in source code.
- Store credentials in Code Engine registry secrets or secure secret managers.
- Use API key authentication for automation and CI/CD.

## Recommended Paths

### Local Development

1. Run `ibmcloud login --sso` or `ibmcloud login --apikey <your-api-key>`
2. Install the container registry plugin
3. Run `ibmcloud cr login`

### Code Engine Deployment

1. Create an IBM Cloud API key
2. Create a Code Engine registry secret
3. Reference the secret in the deployment command
