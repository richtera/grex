"use strict"
var q = require('q');
var http = require('http');
var url = require('url');
var toString = Object.prototype.toString,
    push = Array.prototype.push;

var pathBase = '/graphs/';
var gremlinExt = '/tp/gremlin?script=';
var batchExt = '/tp/batch/tx';
var newVertex = '/vertices';
var graphRegex = /^T\.(gt|gte|eq|neq|lte|lt)$|^g\.|^Vertex(?=\.class\b)|^Edge(?=\.class\b)/;
var closureRegex = /^\{.*\}$/;

function isIdString(id) {
    return !!this.OPTS.idRegex && isString(id) && this.OPTS.idRegex.test(id);
}

function isString(o) {
    return toString.call(o) === '[object String]';
}

function isGraphReference (val) {
    return isString(val) && graphRegex.test(val);
}

function isObject(o) {
    return toString.call(o) === '[object Object]';
}

function isClosure(val) {
    return isString(val) && closureRegex.test(val);   
}

function isArray(o) {
    return toString.call(o) === '[object Array]';
}

function postData(urlPath, data){
    var self = this;
    var deferred = q.defer();
    var payload = JSON.stringify(data) || '{}';
    
    var options = {
        'host': this.OPTS.host,
        'port': this.OPTS.port,
        'path': (this.OPTS.pathBase || pathBase) + this.OPTS.graph,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload, 'utf8'),
            'Accept': 'application/json'
        },
        'method': 'POST'
    };
    options.path += urlPath;
    
    function tryOperation(retry) {
      if (self.OPTS.authToken) {
        options.headers.authorization = self.OPTS.authToken;
      }
      var req = http.request(options, function(res) {
          var body = '';
          var o = {};

          res.on('data', function (chunk) {
              body += chunk;
          });
          res.on('end', function() {
            if (res.statusCode == 200) {
              o = JSON.parse(body);
              if('success' in o && o.success == false){
                  //send error info with reject
                  if(self.newVertices && !!self.newVertices.length){
                      //This indicates that all new Vertices were created but failed to
                      //complete the rest of the tranasction so the new Vertices need deleted
                      rollbackVertices.call(self)
                          .then(function(result){
                              deferred.reject(result);
                          },function(error){
                              deferred.reject(error);
                          });
                  } else {
                      deferred.reject(o);
                  }
              } else {
                  delete o.version;
                  delete o.queryTime;
                  delete o.txProcessed;
                  //This occurs after newVertices have been created
                  //and passed in to postData
                  if(!('results' in o) && self.newVertices && !!self.newVertices.length){
                      o.newVertices = [];
                      push.apply(o.newVertices, self.newVertices);
                      self.newVertices.length = 0;
                  }
                  if('tx' in data){
                      data.tx.length = 0;
                  }
                  deferred.resolve(o);
              }
            } else {
              if (retry) {
                self.clientAuth(new Error('http error ' + res.statusCode), function (err) {
                  if (err)
                    return deferred.reject(err);
                  tryOperation(false);
                });
              } else {
                deferred.reject(new Error('http error ' + res.statusCode));
              }
            }
          });
      });

      req.on('error', function(e) {
          console.error('problem with request: ' + e.message);
          deferred.reject(e);
      });

      // write data to request body
      req.write(payload);
      req.end();
    }
    tryOperation(true);
    return deferred.promise;
}

function qryMain(method, options, createNew){
    return function(){
        var self = this,
            gremlin,
            args = isArray(arguments[0]) ? arguments[0] : arguments,
            appendArg = '';

        gremlin = createNew ? new Gremlin(options) : self._buildGremlin(self.params);
                 
        //cater for idx param 2
        if(method == 'idx' && args.length > 1){
            for (var k in args[1]){
                appendArg = k + ":";
                appendArg += parseArgs.call(self, args[1][k])
            }
            appendArg = "[["+ appendArg + "]]";
            args.length = 1;
        }
        gremlin.params += '.' + method + buildArgs.call(self, args);
        gremlin.params += appendArg;
        return gremlin;
    }
}

function parseArgs(val) {
    //check to see if the arg is referencing the graph ie. g.v(1)
    if(isObject(val) && val.hasOwnProperty('params') && isGraphReference(val.params)){
        return val.params.toString();
    }
    if(isGraphReference(val)) {
        return val.toString();
    }
    //Cater for ids that are not numbers but pass parseFloat test
    if(isIdString.call(this, val) || isNaN(parseFloat(val))) {
        return "'" + val + "'";
    }
    if(!isNaN(parseFloat(val))) {
         return val.toString();    
    }
    return val;
}

//[i] => index & [1..2] => range
//Do not pass in method name, just string arg
function qryIndex(){
    return function(arg) {
        var gremlin = this._buildGremlin(this.params);
        gremlin.params += '['+ arg.toString() + ']';
        return gremlin;
    }
}

//and | or | put  => g.v(1).outE().or(g._().has('id', 'T.eq', 9), g._().has('weight', 'T.lt', '0.6f'))
function qryPipes(method){
    return function() {
        var self = this,
            gremlin = self._buildGremlin(self.params),
            args = [],
            isArray = isArray(arguments[0]),
            argsLen = isArray ? arguments[0].length : arguments.length;

        gremlin.params += "." + method + "("
        for (var _i = 0; _i < argsLen; _i++) {
            gremlin.params += isArray ? arguments[0][_i].params || parseArgs.call(self, arguments[0][_i]) : arguments[_i].params || parseArgs.call(self, arguments[_i]);
            gremlin.params += ",";
        }
        gremlin.params = gremlin.params.slice(0, -1);
        gremlin.params += ")";
        return gremlin;
    }
}

//retain & except => g.V().retain([g.v(1), g.v(2), g.v(3)])
function qryCollection(method){
    return function() {
        var gremlin = this._buildGremlin(this.params),
            args = [];

        gremlin.params += "." + method + "(["
        for (var _i = 0, argsLen = arguments[0].length; _i < argsLen; _i++) {
            gremlin.params += arguments[0][_i].params;
            gremlin.params += ",";
        }
        gremlin.params = gremlin.params.slice(0, -1);
        gremlin.params += "])";
        return gremlin;
    }
}

function buildArgs(array) {
    var argList = '',
        append = '',
        jsonString = '';
    for (var _i = 0, l = array.length; _i < l; _i++) {
        if(isClosure(array[_i])){
            append += array[_i];
        } else if (isObject(array[_i]) && array[_i].hasOwnProperty('verbatim')) {
            argList += array[_i].verbatim + ","; 
        } else if (isObject(array[_i]) && !(array[_i].hasOwnProperty('params') && _isGraphReference(array[_i].params))) {
            jsonString = JSON.stringify(array[_i]);
            jsonString = jsonString.replace('{', '[');
            argList += jsonString.replace('}', ']') + ",";
        } else {
            argList += parseArgs.call(this, array[_i]) + ",";
        }
    }
    argList = argList.slice(0, -1);
    return '(' + argList + ')' + append;
}

var Trxn = (function () {

    function Trxn(options) {
        this.OPTS = options;
        this.txArray = [];
        this.newVertices = [];
    }

    //function converts json document to a stringed version with types
    function docWithTypes(doc, offRoot) {
      if (doc === undefined)
        return doc;
      if (doc === null) {
        if (offRoot)
          return "(null,null)";
        return doc;
      }
      try {
        var d = {};
        var self = this;
        if (Array.isArray(doc)) {
          var out = offRoot ? ['(list,('] : [];
          var len = doc.length;
          for (var i = 0; i < len; i++) {
            var item = doc[i];
            out.push(docWithTypes(item, true));
            if (offRoot)
              out.push(',');
          }
          if (offRoot)
            out.splice(out.length - 1, 1, '))');
          d = out.join('');
        } else if (typeof doc === 'object') {
          if (doc.constructor === Date) {
            d = '(long,' + doc.getTime().toString() + ')';
          } else {
            var out = offRoot ? [] : null;
            var keys = Object.keys(doc);
            var len = keys.length;
            for (var i = 0; i < len; i++) {
              var e = keys[i];
              if (/^_id$|^_type$|^_action$|^_inV$|^outV$/.test(e) && !offRoot) {
                d[e] = doc[e];
              } else {
                var v = doc[e];
                if (offRoot) {
                  out.push(i + '=' + docWithTypes(v, true));
                } else {
                  d[e] = docWithTypes(v, true);
                }
              }
            }
            if (offRoot)
              d[e] = '(map,(' + out.join(',') + '))';
          }
        } else {
          if (doc instanceof Boolean || typeof doc === 'boolean') {
            d = doc ? "(b,true)" : "(b,false)";
          } else if (doc instanceof String || typeof doc === 'string') {
            d = doc.toString();
          } else if (doc instanceof Number || typeof doc === 'number') {
            try {
              d = '(l,' + parseInt(doc) + ')';
              if ('(l,' + doc.toString() + ')' !== d)
                throw new Error('Conversion Error (probably overflow)');
            }
            catch (ee) {
              try {
                d = '(d,' + parseFloat(doc) + ')';
                if ('(l,' + doc.toString() + ')' !== d)
                  throw new Error('Conversion Error (probably overflow)');
              }
              catch (ee2) {
                d = doc.toString(); // Assume string
              }
            }
          } else {
            d = doc.toString(); // Must be a string
          }
        }
        return d;
      }
      catch (e) {
        console.log(doc, e);
      }
    }
    function cud(action, type) {
        return function() {
            var o = {},
                argLen = arguments.length,
                i = 0,
                addToTransaction = true;

            if (!!argLen) {
                if(action == 'delete'){
                    o._id = arguments[0];
                    if (argLen > 1) {
                        o._keys = arguments[1];
                    }
                } else {
                    if (type == 'edge') {
                        o = isObject(arguments[argLen - 1]) ? arguments[argLen - 1] : {};
                        if (argLen == 5 || (argLen == 4 && !isObject(o))) {
                            i = 1;
                            o._id = arguments[0];
                        }
                        o._outV = arguments[0 + i];
                        o._inV = arguments[1 + i];
                        o._label = arguments[2 + i];
                    } else {
                        if (isObject(arguments[0])) {
                            //create new Vertex
                            o = arguments[0];
                            push.call(this.newVertices, o);
                            addToTransaction = false;
                        } else {
                            if(argLen == 2){
                                o = arguments[1];
                            }
                            o._id = arguments[0];
                        }
                    }
                }
            //Allow for no args to be passed
            } else if (type == 'vertex') {
                push.call(this.newVertices, o);
                addToTransaction = false;
            }
            if (action == 'update') {
              o = docWithTypes(o);
            }
            o._type = type;
            if (addToTransaction) {
                o._action = action;
                push.call(this.txArray, o);    
            };
            return o;
        }
    }

    //returns an error Object
    function rollbackVertices(){
        var self = this;
        var errObj = { success: false, message : "" };
        //In Error because couldn't create new Vertices. Therefore,
        //roll back all other transactions
        console.error('problem with Transaction');
        self.txArray.length = 0;
        for (var i = self.newVertices.length - 1; i >= 0; i--) {
            //check if any vertices were created and create a Transaction
            //to delete them from the database
            if('_id' in self.newVertices[i]){
                self.removeVertex(self.newVertices[i]._id);
            }
        };
        //This indicates that nothing was able to be created as there
        //is no need to create a tranasction to delete the any vertices as there
        //were no new vertices successfully created as part of this Transaction
        self.newVertices.length = 0;
        if(!self.txArray.length){
            return q.fcall(function () {
                return errObj.message = "Could not complete transaction. Transaction has been rolled back.";
            });
        }

        //There were some vertices created which now need to be deleted from
        //the database. On success throw error to indicate transaction was
        //unsuccessful. On fail throw error to indicate that transaction was
        //unsuccessful and that the new vertices created were unable to be removed
        //from the database and need to be handled manually.
        return postData.call(self, self.OPTS.batchExt || batchExt, { tx: self.txArray })
            .then(function(success){
                return errObj.message = "Could not complete transaction. Transaction has been rolled back.";
            }, function(fail){
                errObj.message =  "Could not complete transaction. Unable to roll back newly created vertices.";
                errObj.ids = self.txArray.map(function(item){
                    return item._id;
                });
                self.txArray.length = 0;
                return errObj;
            }); 
    }


    function post() {
        return function() {
            var self = this;
            var promises = [];
            var newVerticesLen = self.newVertices.length;
            var txLen = this.txArray.length;

            if(!!newVerticesLen){
                for (var i = 0; i < newVerticesLen; i++) {
                    //Need to see why no creating promised
                    //just changed 
                    promises.push(postData.call(self, self.OPTS.newVertex || newVertex, self.newVertices[i]));
                };
                return q.all(promises).then(function(result){
                    var inError = false;
                    //Update the _id for the created Vertices
                    //this filters through the object reference
                    var resultLen = result.length;
                    for (var j = 0; j < resultLen; j++) {
                        if('results' in result[j] && '_id' in result[j].results){
                            self.newVertices[j]._id = result[j].results._id;
                        } else {
                            inError = true;
                        }
                    };

                    if(inError){
                        return rollbackVertices.call(self)
                            .then(function(result){
                                throw result;
                            },function(error){
                                throw error;
                            });
                    } 
                    //Update any edges that may have referenced the newly created Vertices
                    for (var k = 0; k < txLen; k++) {                    
                        if(self.txArray[k]._type == 'edge' && self.txArray[k]._action == 'create'){
                            if (isObject(self.txArray[k]._inV)) {
                                self.txArray[k]._inV = self.txArray[k]._inV._id;
                            }; 
                            if (isObject(self.txArray[k]._outV)) {
                                self.txArray[k]._outV = self.txArray[k]._outV._id;
                            };    
                        }                        
                    };
                    return postData.call(self, self.OPTS.batchExt || batchExt, { tx: self.txArray });
                }, function(err){
                    console.error(err);
                }); 
            } else {
                for (var k = 0; k < txLen; k++) {
                    if(self.txArray[k]._type == 'edge' && self.txArray[k]._action == 'create'){
                        if (isObject(self.txArray[k]._inV)) {
                            self.txArray[k]._inV = self.txArray[k]._inV._id;
                        }; 
                        if (isObject(this.txArray[k]._outV)) {
                            self.txArray[k]._outV = self.txArray[k]._outV._id;
                        };    
                    }                        
                };
                return postData.call(self, self.OPTS.batchExt || batchExt, { tx: self.txArray });
            }
        }
    }

    Trxn.prototype = {
        addVertex: cud('create', 'vertex'),
        addEdge: cud('create', 'edge'),
        removeVertex: cud('delete', 'vertex'),
        removeEdge: cud('delete', 'edge'),
        updateVertex: cud('update', 'vertex'),
        updateEdge: cud('update', 'edge'),
        commit: post()
    }
    return Trxn;
})();

var Gremlin = (function () {
    function Gremlin(options) {
        this.OPTS = options;
        this.params = 'g';
    }
  
    function get() {
        return function(success, error){
            return getData.call(this).then(success, error);
        }
    }

    function clientAuth(error, callback) {
      if (!this.OPTS.clientId) {
        if (callback)
          callback(error);
        return;
      }
      var u = url.parse(this.OPTS.tokenUrl);
      var options = {
        host: u.hostname,
        port: u.port,
        path: u.path,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        },
        'method': 'POST'
      };
      var self = this;
      var req = http.request(options, function (res) {
        var body = '';
        res.on('data', function (c) {
          body += c;
        });
        res.on('error', function (e) {
          if (callback) {
            callback(e);
            callback = null;
          }
          self.OPTS.authToken = null;
        });
        res.on('end', function () {
          if (res.statusCode == 200) {
            var o = JSON.parse(body);
            self.OPTS.authToken = o.token_type + ' ' + o.access_token;
            callback(null);
          } else {
            callback(error);
          }
        });
      });      
      req.on('error', function (e) {
        if (callback) {
          callback(e);
          callback = null;
        }
      });
      req.write('grant_type=client_credentials'
        + '&client_id=' + this.OPTS.clientId
        + '&client_secret=' + this.OPTS.clientSecret
        + '&scope=' + this.OPTS.clientScopes);
      req.end();
    }
    function getData() {
        var deferred = q.defer();
        var options = {
            'host': this.OPTS.host,
            'port': this.OPTS.port,
            'path': (this.OPTS.pathBase || pathBase) + this.OPTS.graph + (this.OPTS.gremlinExt || gremlinExt) + encodeURIComponent(this.params),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            'method': 'GET'
        };
        var self = this;
        function tryOperation(retry) {
          if (self.OPTS.authToken) {
            options.headers.authorization = self.OPTS.authToken;
          }
          http.get(options, function(res) {
              var body = '';
              var o = {};
              res.on('data', function(results) {
                  body += results;
              });

              res.on('end', function() {
                if (res.statusCode == 200) {
                  o = JSON.parse(body);
                  delete o.version;
                  delete o.queryTime;
                  deferred.resolve(o);
                } else {
                  if (retry) {
                    self.clientAuth(new Error('http error ' + res.statusCode), function (err) {
                      if (err)
                        return deferred.reject(err);
                      tryOperation(false);
                    });
                  } else {
                    deferred.reject(new Error('http error ' + res.statusCode));
                  }
                }
              });
          }).on('error', function(e) {
              deferred.reject(e);
          });
        }
        tryOperation(true);
        return deferred.promise;
    }

    Gremlin.prototype = {
        _buildGremlin: function (qryString){
            this.params = qryString;
            return this;
        },
        
        postData: postData,
        /*** Transform ***/
        both: qryMain('both'),
        bothE: qryMain('bothE'),
        bothV: qryMain('bothV'),
        cap: qryMain('cap'),
        gather: qryMain('gather'),
        id: qryMain('id'),
        'in': qryMain('in'),
        inE: qryMain('inE'),
        inV: qryMain('inV'),
        property: qryMain('property'),
        label: qryMain('label'),
        map: qryMain('map'),
        memoize: qryMain('memoize'),
        order: qryMain('order'),
        out: qryMain('out'),
        outE: qryMain('outE'),
        outV: qryMain('outV'),
        path: qryMain('path'),
        scatter: qryMain('scatter'),
        select: qryMain('select'),
        transform: qryMain('transform'),
        
        /*** Filter ***/
        index: qryIndex(), //index(i)
        range: qryIndex(), //range('[i..j]')
        and:  qryPipes('and'),
        back:  qryMain('back'),
        dedup: qryMain('dedup'),
        except: qryCollection('except'),
        filter: qryMain('filter'),
        has: qryMain('has'),
        hasNot: qryMain('hasNot'),
        interval: qryMain('interval'),
        or: qryPipes('or'),
        random: qryMain('random'),
        retain: qryCollection('retain'),
        simplePath: qryMain('simplePath'),
        
        /*** Side Effect ***/ 
        // aggregate //Not implemented
        as: qryMain('as'),
        groupBy: qryMain('groupBy'),
        groupCount: qryMain('groupCount'), //Not Fully Implemented ??
        optional: qryMain('optional'),
        sideEffect: qryMain('sideEffect'),

        linkBoth: qryMain('linkBoth'),
        linkIn: qryMain('linkIn'),
        linkOut: qryMain('linkOut'),
        // store //Not implemented
        // table //Not implemented
        // tree //Not implemented

        /*** Branch ***/
        copySplit: qryPipes('copySplit'),
        exhaustMerge: qryMain('exhaustMerge'),
        fairMerge: qryMain('fairMerge'),
        ifThenElse: qryMain('ifThenElse'), //g.v(1).out().ifThenElse('{it.name=='josh'}','{it.age}','{it.name}')
        loop: qryMain('loop'),

        /*** Methods ***/
        //fill //Not implemented
        count: qryMain('count'),
        iterate: qryMain('iterate'),
        next: qryMain('next'),
        toList: qryMain('toList'),
        put: qryPipes('put'),

        getPropertyKeys: qryMain('getPropertyKeys'),
        setProperty: qryMain('setProperty'),
        getProperty: qryMain('getProperty'),

        /*** http ***/
        then: get(),
        clientAuth: clientAuth

    }
    return Gremlin;
})();

var gRex = (function(){
        
    function gRex(options){
        //default options
        this.OPTS = {
            'host': 'localhost',
            'port': 8182,
            'graph': 'tinkergraph',
            'idRegex': false // OrientDB id regex -> /^[0-9]+:[0-9]+$/
        };

        if(options){
            this.setOptions(options);
        }

        this.postData = postData;
        this.V = qryMain('V', this.OPTS, true);
        this._ = qryMain('_', this.OPTS, true);
        this.E = qryMain('E', this.OPTS, true);
        this.V =  qryMain('V', this.OPTS, true);

        //Methods
        this.e = qryMain('e', this.OPTS, true);
        this.idx = qryMain('idx', this.OPTS, true);
        this.v = qryMain('v', this.OPTS, true);

        //Indexing
        this.createIndex = qryMain('createIndex', this.OPTS, true);
        this.createKeyIndex = qryMain('createKeyIndex', this.OPTS, true);
        this.getIndices =  qryMain('getIndices', this.OPTS, true);
        this.getIndexedKeys =  qryMain('getIndexedKeys', this.OPTS, true);
        this.getIndex =  qryMain('getIndex', this.OPTS, true);
        this.dropIndex = qryMain('dropIndex', this.OPTS, true);
        this.dropKeyIndex = qryMain('dropKeyIndex', this.OPTS, true);

        //CUD
        // exports.addVertex = _cud('create', 'vertex');
        // exports.addEdge = _cud('create', 'edge');
        // exports.removeVertex = _cud('delete', 'vertex');
        // exports.removeEdge = _cud('delete', 'edge');
        // exports.updateVertex = _cud('update', 'vertex');
        // exports.updateEdge = _cud('update', 'edge');

        this.clear =  qryMain('clear', this.OPTS, true);
        this.shutdown =  qryMain('shutdown', this.OPTS, true);
        this.getFeatures = qryMain('getFeatures', this.OPTS, true);

    }

    gRex.prototype.setOptions = function (options){
        if(!!options){
            for (var k in options){
                if(options.hasOwnProperty(k)){
                    this.OPTS[k] = options[k];
                }
            }
        }
    }

    gRex.prototype.begin = function (){
        var txn = new Trxn(this.OPTS);
        txn.clientAuth = this.clientAuth;
        return txn;
    }

    return gRex;
})();
module.exports = gRex;
