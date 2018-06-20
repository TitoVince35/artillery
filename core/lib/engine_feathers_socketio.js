/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//
// feathers_socket flow definition
//
// - create:
//     service: user
//     data:
//       username: foo
//       is_archived: false
//       created_at: now
//     acknowledge:
//       capture:
//         - json: "$[1]._id"
//           as: newUserId
//
// - get:
//     service: user
//     id: "345ecb1"
//     acknowledge:
//       capture:
//         - json: "$[1].username"
//           as: userName
//         - json: "$[1].gid"
//           as: userGroupId
//
// - find:
//     service: room
//     query:
//       $or:
//         - is_archived: false
//         - duration:
//             $gt: 3
//     data:
//       is_archived: true
//       updated_at: now
//     options:
//       pagination:
//         skip: 20
//         length: 10
//
// - patch:
//     service: room
//     id: null
//     query:
//       $or:
//         - is_archived: false
//         - duration:
//             $gt: 3
//     data:
//       is_archived: true
//       updated_at: now
//     options:
//       pagination:
//         skip: 20
//         length: 10

'use strict';

const async = require('async');
const _ = require('lodash');

const request = require('request');
const io = require('socket.io-client');
const wildcardPatch = require('socketio-wildcard')(io.Manager);

const deepEqual = require('deep-equal');
const debug = require('debug')('feathers_socketio');
const engineUtil = require('./engine_util');
const EngineHttp = require('./engine_http');
const template = engineUtil.template;
module.exports = FeathersSocketIoEngine;

// Valid Service Methods
const validServiceMethods = ['create','get', 'find', 'patch', 'update', 'delete']

function FeathersSocketIoEngine(script) {
  this.config = script.config;

  this.socketioOpts = this.config.socketio || {};
  this.httpDelegate = new EngineHttp(script);
}

FeathersSocketIoEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;
  let tasks = _.map(scenarioSpec.flow, function(rs) {
    if (rs.think) {
      return engineUtil.createThink(rs, _.get(self.config, 'defaults.think', {}));
    }
    return self.step(rs, ee);
  });

  return self.compile(tasks, scenarioSpec.flow, ee);
};

function markEndTime(ee, context, startedAt) {
  let endedAt = process.hrtime(startedAt);
  let delta = (endedAt[0] * 1e9) + endedAt[1];
  ee.debug('response', delta, 0, context._uid);
}

function isResponseRequired(reqSpec) {
  const reqDetails = getRequestDetails(reqSpec);
  return reqDetails.response && reqDetails.response.channel;
}

function isAcknowledgeRequired(reqSpec) {
  return getRequestDetails(reqSpec).hasOwnProperty('acknowledge');
}

function processResponse(ee, data, response, context, callback) {
  // Do we have supplied data to validate?
  if (response.data && !deepEqual(data, response.data)) {
    debug(data);
    let err = 'data is not valid';
    ee.emit('error', err);
    return callback(err, context);
  }

  // If no capture or match specified, then we consider it a success at this point...
  if (!response.capture && !response.match) {
    return callback(null, context);
  }

  // Construct the (HTTP) response...
  let fauxResponse = {body: JSON.stringify(data)};

  // Handle the capture or match clauses...
  engineUtil.captureOrMatch(response, fauxResponse, context, function(err, result) {
    // Were we unable to invoke captureOrMatch?
    if (err) {
      debug(data);
      ee.emit('error', err);
      return callback(err, context);
    }

    // Do we have any failed matches?
    let haveFailedMatches = _.some(result.matches, function(v, k) {
      return !v.success;
    });

    // How to handle failed matches?
    if (haveFailedMatches) {
      // TODO: Should log the details of the match somewhere
      ee.emit('error', 'Failed match');
      return callback(new Error('Failed match'), context);
    } else {
      // Emit match events...
      _.each(result.matches, function(v, k) {
        ee.emit('match', v.success, {
          expected: v.expected,
          got: v.got,
          expression: v.expression
        });
      });

      // Populate the context with captured values
      _.each(result.captures, function(v, k) {
        context.vars[k] = v;
      });

      // Replace the base object context
      // Question: Should this be JSON object or String?
      context.vars.$ = fauxResponse.body;

      // Increment the success count...
      context._successCount++;

      return callback(null, context);
    }
  });
}

///////////////////////////////////////////////////////////////
//////////////////// THIS IS WHERE THE SHIT HAPPENS ///////////
///////////////////////////////////////////////////////////////

// Get the type of a RequestSpec amongst validServiceMethods
const getRequestType = requestSpec =>
  Object.keys(requestSpec)
  .find(prop => validServiceMethods.includes(prop))

// Return request details from a RequestSpec set
// ie, the data inside the 'patch', 'find' or whatever method field this may be
const getRequestDetails = requestSpec =>
  requestSpec[getRequestType(requestSpec)]

const isEmitRequest = requestSpec =>
  Object.keys(requestSpec)
  .some(prop => validServiceMethods.includes(prop))

FeathersSocketIoEngine.prototype.step = function (requestSpec, ee) {
  let self = this;

  // debug("== This step starts with '" + Object.keys(requestSpec)[0] + "'")

  // Process "loops"
  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      return self.step(rs, ee);
    });

    return engineUtil.createLoopWithCount(
      requestSpec.count || -1,
      steps,
      {
        loopValue: requestSpec.loopValue,
        overValues: requestSpec.over
      }
    );
  }


  // TODO : verify "requestSpec.service"

  //// Build up request message
  let stepRequest = {}, reqDetails
  stepRequest.method = getRequestType(requestSpec)
  stepRequest.isEmitRequest = typeof stepRequest.method === 'string'
  if (stepRequest.isEmitRequest) {
    reqDetails = requestSpec[stepRequest.method]
    stepRequest.service = reqDetails.service
  }

  ////////////// Single request/message
  //////////////////////////////////////////////////////////

  let emitStepMessage = function(context, callback) {
    // Delegate to the think utility
    if (requestSpec.think) {
      debug(`-- into emitStepMessage() - think`)
      return engineUtil.createThink(requestSpec, _.get(self.config, 'defaults.think', {}));
    }
    // TODO : delegate functions, http stuff...
    if (!stepRequest.isEmitRequest) {
      debug(`-- into emitStepMessage() - Not an 'emit' request, let's delegate`)
      let delegateFunc = self.httpDelegate.step(requestSpec, ee);
      return delegateFunc(context, callback);
    }

    debug(`-- into emitStepMessage() for ${stepRequest.service}/${stepRequest.method}`)

    ee.emit('request');
    let startedAt = process.hrtime();

    // Reclaim my socket
    let socketio = context.sockets[reqDetails.namespace] || null;

    if (! (stepRequest.isEmitRequest && socketio) ) {
      return ee.emit('error', 'invalid arguments - no valid service method or no socket');
    }

    // Prepare stepRequest message
    stepRequest.arguments = [`${stepRequest.service}::${stepRequest.method}`]
    if (reqDetails.id) {
      stepRequest.arguments.push(template(reqDetails.id, context))
    }
    if (reqDetails.query) {
      stepRequest.arguments.push(template(reqDetails.query, context))
    }
    if (reqDetails.data) {
      stepRequest.arguments.push(template(reqDetails.data, context))
    }
    if (reqDetails.options) {
      stepRequest.arguments.push(template(reqDetails.options, context))
    }

    let endCallback = function (err, context) {

      /////// CALLBACK FOR EMIT ACKNOWLEDGE PROCESSING
      const processAcknowledge  = () => {
        debug("-- into processAcknowledge()")
        let response = {
          data: template(reqDetails.acknowledge.data, context),
          capture: template(reqDetails.acknowledge.capture, context),
          match: template(reqDetails.acknowledge.match, context)
        };
        // Make sure data, capture or match has a default json spec for parsing socketio responses
        _.each(response, function (r) {
          if (_.isPlainObject(r) && !('json' in r)) {
            r.json = '$.0'; // Default to the first callback argument
          }
        });
        // Acknowledge data can take up multiple arguments of the emit callback
        processResponse(ee, arguments, response, context, function (err) {
          if (!err) {
            markEndTime(ee, context, startedAt);
          }
          return callback(err, context);
        });
      }

      if (err) {
        debug(err);
      }

      if (isAcknowledgeRequired(requestSpec)) {
        debug("before pushing processAcknowledge()", stepRequest.arguments)
        stepRequest.arguments.push(processAcknowledge);
        debug("Calling emit", stepRequest.arguments)
        socketio.emit(...stepRequest.arguments);
      }
      else {
        // No acknowledge data is expected, so emit without a listener
        debug("Calling emit no ackownledge", stepRequest.arguments)
        socketio.emit(...stepRequest.arguments);
        markEndTime(ee, context, startedAt);
        return callback(null, context);
      }
    };

    if (isResponseRequired(requestSpec)) {
      debug("Response required (no acknowledge)")
      let response = {
        channel: template(reqDetails.response.channel, context),
        data: template(reqDetails.response.data, context),
        capture: template(reqDetails.response.capture, context),
        match: template(reqDetails.response.match, context)
      };
      // Listen for the socket.io response on the specified channel
      let done = false;
      socketio.on(response.channel, function receive(data) {
        done = true;
        processResponse(ee, data, response, context, function(err) {
          if (!err) {
            markEndTime(ee, context, startedAt);
          }
          // Stop listening on the response channel
          socketio.off(response.channel);
          return endCallback(err, context);
        });
      });
      // Send the data on the specified socket.io channel
      debug("Calling emit - response Required no acknowledge", stepRequest.arguments)
      socketio.emit(...stepRequest.arguments);
      // If we don't get a response within the timeout, fire an error
      let waitTime = self.config.timeout || 10;
      waitTime *= 1000;
      setTimeout(function responseTimeout() {
        if (!done) {
          let err = 'response timeout';
          ee.emit('error', err);
          return callback(err, context);
        }
      }, waitTime);
    } else {
      endCallback(null, context);
    }
  };

  function preStep(context, callback){
    debug(`-- into preStep() for ${stepRequest.service}/${stepRequest.method}`)
    // Set default namespace in emit action
    reqDetails.namespace = template(reqDetails.namespace, context) || "/";

    self.loadContextSocket(reqDetails.namespace, context, function(err, socket){
      if(err) {
        debug(err);
        ee.emit('error', err.message);
        return callback(err, context);
      }

      return emitStepMessage(context, callback);
    });
  }

  if(stepRequest.isEmitRequest) {
    // debug("Will go to preStep()")
    return preStep;
  } else {
    // debug("Will go to emitStepMessage()")
    return emitStepMessage;
  }
};
///////////////////////////////////////////////////////////////
/////////////////////// AND NOW WE'RE DONE
///////////////////////////////////////////////////////////////

FeathersSocketIoEngine.prototype.loadContextSocket = function(namespace, context, cb) {
  context.sockets = context.sockets || {};

  if(!context.sockets[namespace]) {
    let target = this.config.target + namespace;
    let tls = this.config.tls || {};

    const socketioOpts = template(this.socketioOpts, context);
    let options = _.extend(
      {},
      socketioOpts, // templated
      tls
    );

    let socket = io(target, options)

    // Feathers proxy : rearrange arguments according to method
    // let socket = Object.create(io(target, options))
    // socket.emit = function(channel, data, callback) {
    //   // It's a Feathers request with separate id
    //   if (data.feathersId) {
    //     const id = data.feathersId
    //     const strippedData = { ...data }
    //     delete strippedData.feathersId
    //     debug(`Feathers call to ${channel} with id ${id} and data =`, strippedData)
    //     return this.__proto__.emit.call(this,channel, id, strippedData, callback)
    //   }
    //   return this.__proto__.emit.call(this, channel, data, callback)
    // }

    context.sockets[namespace] = socket;
    wildcardPatch(socket);


    socket.on('*', function () {
      context.__receivedMessageCount++;
    });

    socket.once('connect', function() {
      cb(null, socket);
    });
    socket.once('connect_error', function(err) {
      cb(err, null);
    });
  } else {
    return cb(null, context.sockets[namespace]);
  }
};

FeathersSocketIoEngine.prototype.closeContextSockets = function (context) {
  // if(context.socketio) {
  //   context.socketio.disconnect();
  // }
  if(context.sockets && Object.keys(context.sockets).length > 0) {
    var namespaces = Object.keys(context.sockets);
    namespaces.forEach(function(namespace){
      context.sockets[namespace].disconnect();
    });
  }
};


FeathersSocketIoEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  let config = this.config;
  let self = this;

  function zero(callback, context) {
    context.__receivedMessageCount = 0;
    ee.emit('started');
    self.loadContextSocket('/', context, function done(err) {
      if (err) {
        ee.debug('error', err);
        return callback(err, context);
      }

      return callback(null, context);
    });
  }

  return function scenario(initialContext, callback) {
    initialContext._successCount = 0;
    initialContext._jar = request.jar();
    initialContext._pendingRequests = _.size(
        _.reject(scenarioSpec, function(rs) {
          return (typeof rs.think === 'number');
        }));

    let steps = _.flatten([
      function z(cb) {
        return zero(cb, initialContext);
      },
      tasks
    ]);

    async.waterfall(
        steps,
        function scenarioWaterfallCb(err, context) {
          if (err) {
            debug(err);
          }
          if (context) {
            self.closeContextSockets(context);
          }
          return callback(err, context);
        });
  };
};
