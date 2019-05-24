'use strict';
const documentation = require('./documentation');
const models = require('./models');
const swagger = require('./swagger');
const openapi = require('./openapi');
const SwaggerParser = require('swagger-parser');
const fs = require('fs');
const downloadDocumentation = require('./downloadDocumentation');
const BbPromise = require('bluebird');
const cloneDeep = require('lodash.clonedeep');

class ServerlessAWSDocumentation {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = 'aws';
    this.fs = fs;

    Object.assign(this, models);
    Object.assign(this, swagger);
    Object.assign(this, openapi);
    Object.assign(this, documentation());
    Object.assign(this, downloadDocumentation);

    this.customVars = this.serverless.variables.service.custom;
    const naming = this.serverless.providers.aws.naming;
    this.getMethodLogicalId = naming.getMethodLogicalId.bind(naming);
    this.normalizePath = naming.normalizePath.bind(naming);

    this._beforeDeploy = () => BbPromise.bind(this).then(this.beforeDeploy)
    this._afterDeploy = this.afterDeploy.bind(this)
    this._download = downloadDocumentation.downloadDocumentation.bind(this)

    this.hooks = {
      'before:package:finalize': this._beforeDeploy,
      'after:deploy:deploy': this._afterDeploy,
      'downloadDocumentation:downloadDocumentation': this._download
    };

    this.documentationParts = [];

    this.commands = {
        downloadDocumentation: {
            usage: 'Download API Gateway documentation from AWS',
            lifecycleEvents: [
              'downloadDocumentation',
            ],
            options: {
                outputFileName: {
                  required: true,
                },
                extensions: {
                    required: false,
                },
            },
        }
    };
  }

  log(format, ...args) {
    this.serverless.cli.log(`[serverless-aws-documentation] ${format}`, ...args);
  }

  beforeDeploy() {
    return BbPromise.fromCallback(done => {
      this.customVars = this.serverless.variables.service.custom;
      if (!(this.customVars && this.customVars.documentation)) return;

      if (this.customVars.documentation.openapi) {
        const api = this.customVars.documentation.api;
        const clonedApi = cloneDeep(api);
        const self = this;
        SwaggerParser.validate(clonedApi, null, function (err, parsedData) {
          if (err) {
            self.log(err);
            process.exit(0)
          }

          const {paths} = self.customVars.documentation.api;
          const {components, paths: parsePath} = parsedData;
          // Handle references to models
          self.replaceOpenAPIIDefinitions(api.components.schemas)
          //Map swagger into documentation models
          const openAPIDefs = (components || {}).schemas;
          if (openAPIDefs) {
            self.customVars.documentation.models = Object
              .keys(openAPIDefs)
              .map(definitionName => {
                return {
                  name: definitionName,
                  description: openAPIDefs[definitionName].description,
                  contentType: 'application/json',
                  schema: openAPIDefs[definitionName]
                }
              })
          } else {
            self.customVars.documentation.models = []
          }

          // Find http events and map the swagger across
          self.serverless.service.getAllFunctions().forEach(functionName => {
            const func = self.serverless.service.getFunction(functionName)
            if (func.events) {
              func.events.forEach(event => {
                if (event.http) {
                  // look up the path in the open api specs
                  const path = paths['/' + event.http.path]
                  if (path) {
                    const method = path[event.http.method]
                    if (!method) {
                      self.log(`Documentation for function ${functionName} not found for event with ${event.http.method}`)
                      return; // if documentation not found, check for other documentation
                    }
                    const methodDoc = {
                      'requestHeaders': [],
                      'pathParams': [],
                      'queryParams': [],
                      'requestModels': {},
                      description: method.description,
                      summary: method.summary,
                    }
                    if (method.parameters) {
                      const parameters = parsePath['/' + event.http.path][event.http.method].parameters;
                      parameters.forEach(param => {
                        if (param.in === 'header') {
                          methodDoc['requestHeaders'].push({
                            name: param.name,
                            description: param.description,
                            required: param.required
                          })
                        } else if (param.in === 'path') {
                          methodDoc['pathParams'].push({
                            name: param.name,
                            description: param.description,
                            required: param.required
                          })

                        } else if (param.in === 'query') {
                          methodDoc['queryParams'].push({
                            name: param.name,
                            description: param.description,
                            required: param.required
                          })
                        } else if (param.in === 'body') {
                          const name = `${functionName}Request`;
                          methodDoc['requestModels']['application/json'] =
                            self.extractOpenAPIModel(param, name, self.customVars.documentation.models);
                        }
                      })
                    }

                    if ((method.requestBody || {}).content) {
                      const name = `${functionName}Request`;
                      methodDoc['requestModels']['application/json'] =
                        self
                          .extractOpenAPIModel((method.requestBody || {})
                            .content['application/json'], name, self.customVars.documentation.models);
                    }

                    if (method.responses) {
                      const name = `${functionName}Response`;
                      methodDoc['methodResponses'] = [];
                      Object.keys(method.responses).map(statusCode => {
                        const response = method.responses[statusCode];
                        const methodResponse = {
                          statusCode: '' + statusCode,
                        };
                        if ((response.content && response.content['application/json'] || {}).schema) {
                          const responseModels = {};
                          responseModels['application/json'] =
                            self.extractOpenAPIModel(response.content['application/json'], name, self.customVars.documentation.models);

                          methodResponse['responseModels'] = responseModels;
                        }
                        methodDoc['methodResponses'].push(methodResponse);
                      });
                    }
                    event.http.documentation = methodDoc;
                  }
                }
              })
            }
          });
          self.checkCFTemplate();
          done();
        });
      } else {
        if (this.customVars.documentation.swagger) {
          // Handle references to models
          this.replaceSwaggerDefinitions(this.customVars.documentation.definitions)
          //Map swagger into documentation models
          const swaggerDefs = this.customVars.documentation.definitions
          if (swaggerDefs) {
            const swaggerModels = Object.keys(swaggerDefs).map(definitionName => {
              return {
                name: definitionName,
                description: swaggerDefs[definitionName].description,
                contentType: 'application/json',
                schema: swaggerDefs[definitionName]
              }
            })
            this.customVars.documentation.models = swaggerModels
          } else {
            this.customVars.documentation.models = []
          }

          //Find http events and map the swagger across
          this.serverless.service.getAllFunctions().forEach(functionName => {
            const func = this.serverless.service.getFunction(functionName)
            if (func.events) {
              func.events.forEach(event => {
                if (event.http) {
                  // look up the path in the swagger
                  const path = this.customVars.documentation.paths['/' + event.http.path]
                  if (path) {
                    const method = path[event.http.method]
                    const methodDoc = {
                      'requestHeaders': [],
                      'pathParams': [],
                      'queryParams': [],
                      'requestModels': {},
                      description: method.description,
                      summary: method.summary,
                    }
                    if (method.parameters) {
                      method.parameters.forEach(param => {
                        if (param.in === 'header') {
                          methodDoc['requestHeaders'].push({
                            name: param.name,
                            description: param.description,
                            required: param.required
                          })
                        } else if (param.in === 'path') {
                          methodDoc['pathParams'].push({
                            name: param.name,
                            description: param.description,
                            required: param.required
                          })
                        } else if (param.in === 'query') {
                          methodDoc['queryParams'].push({
                            name: param.name,
                            description: param.description,
                            required: param.required
                          })
                        } else if (param.in === 'body') {
                          methodDoc['requestModels']['application/json'] =
                            this.extractModel(param, this.customVars.documentation.models);
                        }
                      })
                    }

                    if (method.responses) {
                      methodDoc['methodResponses'] = []
                      Object.keys(method.responses).map(statusCode => {
                        const response = method.responses[statusCode];
                        const methodResponse = {
                          statusCode: '' + statusCode,
                        };

                        if (response.schema) {
                          const responseModels = {};
                          responseModels['application/json'] =
                            this.extractModel(response, this.customVars.documentation.models);
                          methodResponse['responseModels'] = responseModels;
                        }
                        methodDoc['methodResponses'].push(methodResponse);
                      });
                    }

                    event.http.documentation = methodDoc
                  }
                }
              })
            }
          })
        }
        this.checkCFTemplate();
        done();
      }
    })
  }

  checkCFTemplate() {
    this.cfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;

    // The default rest API reference
    let restApiId = {
      Ref: 'ApiGatewayRestApi',
    };

    // Use the provider API gateway if one has been provided.
    if (this.serverless.service.provider.apiGateway && this.serverless.service.provider.apiGateway.restApiId) {
      restApiId = this.serverless.service.provider.apiGateway.restApiId
    }

    if (this.customVars.documentation.models) {
      const cfModelCreator = this.createCfModel(restApiId);

      // Add model resources
      const models = this.customVars.documentation.models.map(cfModelCreator)
        .reduce((modelObj, model) => {
          modelObj[`${model.Properties.Name}Model`] = model;
          return modelObj;
        }, {});
      Object.assign(this.cfTemplate.Resources, models);
    }

    // Add models to method resources
    this.serverless.service.getAllFunctions().forEach(functionName => {
      const func = this.serverless.service.getFunction(functionName);
      func.events.forEach(this.updateCfTemplateFromHttp.bind(this));
    });

    // Add models
    this.cfTemplate.Outputs.AwsDocApiId = {
      Description: 'API ID',
      Value: restApiId,
    };
  }

  afterDeploy() {
    if (!this.customVars.documentation) return;
    const stackName = this.serverless.providers.aws.naming.getStackName(this.options.stage);
    return this.serverless.providers.aws.request('CloudFormation', 'describeStacks', { StackName: stackName },
      this.options.stage,
      this.options.region
    ).then(this._buildDocumentation.bind(this))
    .catch(err => {
      if (err === 'documentation version already exists, skipping upload') {
        return Promise.resolve();
      }

      return Promise.reject(err);
    });
  }

}

module.exports = ServerlessAWSDocumentation;
