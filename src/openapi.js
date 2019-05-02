'use strict'

function replaceOpenAPIRefs (openAPISpec) {
  function replaceRefs (obj) {
    if (!obj) {
      return
    }
    for (let key of Object.keys(obj)) {
      if (key === '$ref') {
        let match
        if (match = /#\/components\/schemas\/([\-\w]+)/.exec(obj[key])) {
          obj[key] = '{{model: ' + match[1] + '}}'
        }
      } else if (typeof obj[key] === 'object') {
        replaceRefs(obj[key])
      }
    }
  }

  replaceRefs(openAPISpec)
}

function extractModelDefinition(param, name, models) {
  // if the schema is just a $ref, set it to that value
  // otherwise create a model to handle this response
  if (param.schema['$ref']) {
    let match
    if (match = /#\/components\/schemas\/([\-\w]+)/.exec(param.schema['$ref'])) {
      return match[1];
    }
  } else {
    replaceOpenAPIRefs(param.schema)
    models.push({
      name,
      description: param.description,
      contentType: 'application/json',
      schema: param.schema
    })
    return name;
  }
}

module.exports = {
  replaceOpenAPIIDefinitions: function replaceSwaggerDefinitions (openAPISpecs) {
    return replaceOpenAPIRefs(openAPISpecs)
  },
  extractOpenAPIModel: function extractModel(param, name, models) {
    return extractModelDefinition(param, name, models)
  }
}
