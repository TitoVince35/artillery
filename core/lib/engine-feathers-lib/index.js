
const debug = require('debug')('feathers_socketio_details');
const engineUtil = require('../engine_util');
const template = engineUtil.template;

// Valid Service Methods
const validServiceMethods = ['create','get', 'find', 'patch', 'update', 'remove']

module.exports = {
  processApiCallDetailsToEmitArgs,
  getRequestType,
  getRequestDetails
}

// Get the type of a RequestSpec amongst validServiceMethods
function getRequestType(requestSpec) {
  return Object.keys(requestSpec)
    .find(prop => validServiceMethods.includes(prop))
}

// Return request details from a RequestSpec set
// ie, the data inside the 'patch', 'find' or whatever method field this may be
function getRequestDetails(requestSpec) {
  return requestSpec[getRequestType(requestSpec)]
}

/**
 * bla
 */
function processApiCallDetailsToEmitArgs(reqDetails, context) {
  if (reqDetails.service==='authenticate') {
    return processAuthenticateRequest(reqDetails, context)
  }
  switch(reqDetails.method) {
    case 'create':
      return processCreateRequest(reqDetails, context);
      break;
    case 'patch':
    case 'update':
      return processPatchUpdateRequest(reqDetails, context);
      break;
    case 'get':
      return processGetRequest(reqDetails, context);
      break;
    case 'find':
      return processFindRequest(reqDetails, context);
      break;
    case 'remove':
      return processRemoveRequest(reqDetails, context);
      break;
    default:
      throw 'Unknow request method '+reqDetails.method
  }
}

function processAuthenticateRequest(rq, ctx) {
  return [
      'authenticate',
      template(rq.data,ctx)
  ]
}

function processCreateRequest(rq,ctx) {
  const res = [
    `${rq.service}::create`,
    template(rq.data,ctx)
  ]
  if (rq.params) {
    res.push(template(rq.params,ctx))
  }
  return res
}

function processGetRequest(rq,ctx) {
  return [
    `${rq.service}::get`,
    template(rq.id,ctx)
  ]
  if (rq.params) {
    res.push(template(rq.params,ctx))
  }
  return res
}

function processFindRequest(rq,ctx) {
  const res = [
    `${rq.service}::find`,
    rq.id ? template(rq.id,ctx) : null
  ]
  if (rq.params && rq.params.query) {
    res.push(template(rq.params.query,ctx))
  }
  return res
}

function processPatchUpdateRequest(rq,ctx) {
  debug('processPatchUpdateRequest()', rq)
  const res = [
    `${rq.service}::${rq.method}`,
    rq.id ? template(rq.id,ctx) : null
  ]
  if (rq.data) {
    res.push(template(rq.data,ctx))
  }
  if (rq.params && rq.params.query) {
    res.push(template(rq.params.query,ctx))
  }
  debug('processPatchUpdateRequest()', res)
  return res
}

function processRemoveRequest(rq,ctx) {
  debug('processRemoveRequest()', rq)
  const res = [
    `${rq.service}::remove`,
    rq.id ? template(rq.id,ctx) : null
  ]
  if (rq.params && rq.params.query) {
    res.push(template(rq.params.query,ctx))
  }
  return res
}
