var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('localtunnel:client');
var net = require('net');

var HeaderHostTransformer = require('./HeaderHostTransformer');

var connectionRefusedErrorFired = false;

// manages groups of tunnels
var TunnelCluster = function(opt) {
  if (!(this instanceof TunnelCluster)) {
    return new TunnelCluster(opt);
  }

  var self = this;
  self._opt = opt;

  EventEmitter.call(self);
};

TunnelCluster.prototype.__proto__ = EventEmitter.prototype;

// establish a new tunnel
TunnelCluster.prototype.open = function() {
  var self = this;

  debug('establish new tunnel');

  var opt = self._opt || {};

  var remote_host = opt.remote_host;
  var remote_port = opt.remote_port;

  var local_host = opt.local_host || 'localhost';
  var local_port = opt.local_port;

  debug('establishing tunnel %s:%s <> %s:%s', local_host, local_port, remote_host, remote_port);

  // connection to localtunnel server
  var remote = net.connect({
    host: remote_host,
    port: remote_port
  });

  remote.setKeepAlive(true);

  remote.on('error', function(err) {
    debug('error on remote: ' + err);

    if (err.code === 'ECONNREFUSED') {
      debug('connection refused: ' + remote_host + ':' + remote_port + ' (check your firewall settings)');
      debug(`fired: ${connectionRefusedErrorFired}`);
      if (connectionRefusedErrorFired) {
        return;
      }
      connectionRefusedErrorFired = !connectionRefusedErrorFired;
      debug(`fired: ${connectionRefusedErrorFired}`);
    }
    remote.end();
    self.emit('error', err);
  });

  remote.on('data', function(data) {
    const match = data.toString().match(/^(\w+) (\S+)/);
    if (match) {
      self.emit('request', {
        method: match[1],
        path: match[2]
      });
    }
  });

  // tunnel is considered open when remote connects
  remote.once('connect', function() {
    self.emit('open', remote);
    conn_local();
  });

  function conn_local() {
    if (remote.destroyed) {
      debug('remote destroyed');
      self.emit('dead');
      return;
    }

    debug('connecting locally to %s:%d', local_host, local_port);
    remote.pause();

    // connection to local http server
    var local = net.connect({
      host: local_host,
      port: local_port
    });

    function remote_close() {
      debug('remote close');
      self.emit('dead');
      local.end();
    }

    remote.once('close', remote_close);

    // TODO some languages have single threaded servers which makes opening up
    // multiple local connections impossible. We need a smarter way to scale
    // and adjust for such instances to avoid beating on the door of the server
    local.once('error', function(err) {
      debug('local error %s', err.message);
      local.end();

      remote.removeListener('close', remote_close);

      if (err.code !== 'ECONNREFUSED') {
        return remote.end();
      }

      // retrying connection to local server
      setTimeout(conn_local, 1000);
    });

    local.once('connect', function() {
      debug('connected locally');
      remote.resume();

      var stream = remote;

      // if user requested specific local host
      // then we use host header transform to replace the host header
      if (opt.local_host) {
        debug('transform Host header to %s', opt.local_host);
        stream = remote.pipe(HeaderHostTransformer({ host: opt.local_host }));
      }

      stream.pipe(local).pipe(remote);

      // when local closes, also get a new remote
      local.once('close', function(had_error) {
        debug('local connection closed [%s]', had_error);
      });
    });
  }
};

module.exports = TunnelCluster;
