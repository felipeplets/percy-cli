import { request as makeRequest } from '@percy/client/utils';
import logger from '@percy/logger';
import mime from 'mime-types';
import { DefaultMap, createResource, hostnameMatches, normalizeURL, waitFor } from './utils.js';

const MAX_RESOURCE_SIZE = 25 * (1024 ** 2); // 25MB
const ALLOWED_STATUSES = [200, 201, 301, 302, 304, 307, 308];
const ALLOWED_RESOURCES = ['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Other'];
const ABORTED_MESSAGE = 'Request was aborted by browser';

// RequestLifeCycleHandler handles life cycle of a requestId
// Ideal flow:          requestWillBeSent -> requestPaused -> responseReceived -> loadingFinished / loadingFailed
// ServiceWorker flow:  requestWillBeSent -> responseReceived -> loadingFinished / loadingFailed
class RequestLifeCycleHandler {
  constructor() {
    this.resolveRequestWillBeSent = null;
    this.resolveResponseReceived = null;
    this.requestWillBeSent = new Promise((resolve) => (this.resolveRequestWillBeSent = resolve));
    this.responseReceived = new Promise((resolve) => (this.resolveResponseReceived = resolve));
  }
}
// The Interceptor class creates common handlers for dealing with intercepting asset requests
// for a given page using various devtools protocol events and commands.
export class Network {
  static TIMEOUT = undefined;

  log = logger('core:discovery');

  #requestsLifeCycleHandler = new DefaultMap(() => new RequestLifeCycleHandler());
  #pending = new Map();
  #requests = new Map();
  #authentications = new Set();
  #aborted = new Set();

  constructor(page, options) {
    this.page = page;
    this.timeout = options.networkIdleTimeout ?? 100;
    this.authorization = options.authorization;
    this.requestHeaders = options.requestHeaders ?? {};
    this.captureMockedServiceWorker = options.captureMockedServiceWorker ?? false;
    this.userAgent = options.userAgent ??
      // by default, emulate a non-headless browser
      page.session.browser.version.userAgent.replace('Headless', '');
    this.intercept = options.intercept;
    this.meta = options.meta;
    this._initializeNetworkIdleWaitTimeout();
  }

  watch(session) {
    session.on('Network.requestWillBeSent', this._handleRequestWillBeSent);
    session.on('Network.responseReceived', this._handleResponseReceived.bind(this, session));
    session.on('Network.eventSourceMessageReceived', this._handleEventSourceMessageReceived);
    session.on('Network.loadingFinished', this._handleLoadingFinished);
    session.on('Network.loadingFailed', this._handleLoadingFailed);

    let commands = [
      session.send('Network.enable'),
      session.send('Network.setBypassServiceWorker', { bypass: !this.captureMockedServiceWorker }),
      session.send('Network.setCacheDisabled', { cacheDisabled: true }),
      session.send('Network.setUserAgentOverride', { userAgent: this.userAgent }),
      session.send('Network.setExtraHTTPHeaders', { headers: this.requestHeaders })
    ];

    if (this.intercept && session.isDocument) {
      session.on('Fetch.requestPaused', this._handleRequestPaused.bind(this, session));
      session.on('Fetch.authRequired', this._handleAuthRequired.bind(this, session));

      commands.push(session.send('Fetch.enable', {
        handleAuthRequests: true,
        patterns: [{ urlPattern: '*' }]
      }));
    }

    return Promise.all(commands);
  }

  // Resolves after the timeout when there are no more in-flight requests.
  async idle(filter = () => true, timeout = this.timeout) {
    let requests = [];

    this.log.debug(`Wait for ${timeout}ms idle`, this.meta);

    await waitFor(() => {
      if (this.page.session.closedReason) {
        throw new Error(`Network error: ${this.page.session.closedReason}`);
      }

      requests = Array.from(this.#requests.values()).filter(filter);
      return requests.length === 0;
    }, {
      timeout: Network.TIMEOUT,
      idle: timeout
    }).catch(error => {
      if (error.message.startsWith('Timeout')) {
        this._throwTimeoutError((
          'Timed out waiting for network requests to idle.'
        ), filter);
      } else {
        throw error;
      }
    });
  }

  // Validates that requestId is still valid as sometimes request gets cancelled and we have already executed
  // _forgetRequest for the same, but we still attempt to make a call for it and it fails
  // with Protocol error (Fetch.failRequest): Invalid InterceptionId.
  async send(session, method, params) {
    /* istanbul ignore else: currently all send have requestId */
    if (params.requestId) {
      /* istanbul ignore if: race condition, very hard to mock this */
      if (this.isAborted(params.requestId)) {
        throw new Error(ABORTED_MESSAGE);
      }
    }

    return await session.send(method, params);
  }

  isAborted(requestId) {
    return this.#aborted.has(requestId);
  }

  // Throw a better network timeout error
  _throwTimeoutError(msg, filter = () => true) {
    if (this.log.shouldLog('debug')) {
      let reqs = Array.from(this.#requests.values()).filter(filter).map(r => r.url);
      msg += `\n\n  ${['Active requests:', ...reqs].join('\n  - ')}\n`;
    }

    throw new Error(msg);
  }

  // Called when a request should be removed from various trackers
  _forgetRequest({ requestId, interceptId }, keepPending) {
    this.#requests.delete(requestId);
    this.#authentications.delete(interceptId);

    if (!keepPending) {
      this.#pending.delete(requestId);
    }
  }

  // Called when a request requires authentication. Responds to the auth request with any
  // provided authorization credentials.
  _handleAuthRequired = async (session, event) => {
    let { username, password } = this.authorization ?? {};
    let { requestId } = event;
    let response = 'Default';

    if (this.#authentications.has(requestId)) {
      response = 'CancelAuth';
    } else if (username || password) {
      response = 'ProvideCredentials';
      this.#authentications.add(requestId);
    }

    await this.send(session, 'Fetch.continueWithAuth', {
      requestId: event.requestId,
      authChallengeResponse: { response, username, password }
    });
  }

  // Called when a request is made. The request is paused until it is fulfilled, continued, or
  // aborted. If the request is already pending, handle it; otherwise set it to be intercepted.
  _handleRequestPaused = async (session, event) => {
    let { networkId: requestId, requestId: interceptId, resourceType } = event;

    // wait for request to be sent
    await this.#requestsLifeCycleHandler.get(requestId).requestWillBeSent;
    let pending = this.#pending.get(requestId);
    this.#pending.delete(requestId);

    // guard against redirects with the same requestId
    // eslint-disable-next-line babel/no-unused-expressions
    pending?.request.url === event.request.url &&
    pending.request.method === event.request.method &&
    await this._handleRequest(session, { ...pending, resourceType, interceptId });
  }

  // Called when a request will be sent. If the request has already been intercepted, handle it;
  // otherwise set it to be pending until it is paused.
  _handleRequestWillBeSent = async event => {
    let { requestId, request, type } = event;

    // do not handle data urls
    if (request.url.startsWith('data:')) return;

    if (this.intercept) {
      this.#pending.set(requestId, event);
      if (this.captureMockedServiceWorker) {
        await this._handleRequest(undefined, { ...event, resourceType: type, interceptId: requestId }, true);
      }
    }
    // release request
    // note: we are releasing this, even if intercept is not set for network.js
    // since, we want to process all-requests in-order doesn't matter if it should be intercepted or not
    this.#requestsLifeCycleHandler.get(requestId).resolveRequestWillBeSent();
  }

  // Called when a pending request is paused. Handles associating redirected requests with
  // responses and calls this.onrequest with request info and callbacks to continue, respond,
  // or abort a request. One of the callbacks is required to be called and only one.
  _handleRequest = async (session, event, serviceWorker = false) => {
    let { request, requestId, interceptId, resourceType } = event;
    let redirectChain = [];

    // if handling a redirected request, associate the response and add to its redirect chain
    if (event.redirectResponse && this.#requests.has(requestId)) {
      let req = this.#requests.get(requestId);
      redirectChain = [...req.redirectChain, req];
      // clean up interim requests
      this._forgetRequest(req, true);
    }

    request.type = resourceType;
    request.requestId = requestId;
    request.interceptId = interceptId;
    request.redirectChain = redirectChain;
    this.#requests.set(requestId, request);

    if (!serviceWorker) {
      await sendResponseResource(this, request, session);
    }
  }

  // Called when a response has been received for a specific request. Associates the response with
  // the request data and adds a buffer method to fetch the response body when needed.
  _handleResponseReceived = async (session, event) => {
    let { requestId, response } = event;
    // await on requestWillBeSent
    // no explicitly wait on requestWillBePaused as we implictly wait on it, since it manipulates the lifeCycle of request using Fetch module
    await this.#requestsLifeCycleHandler.get(requestId).requestWillBeSent;
    let request = this.#requests.get(requestId);
    /* istanbul ignore if: race condition paranioa */
    if (!request) return;

    request.response = response;
    request.response.buffer = async () => {
      let result = await this.send(session, 'Network.getResponseBody', { requestId });
      return Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf-8');
    };
    // release response
    this.#requestsLifeCycleHandler.get(requestId).resolveResponseReceived();
  }

  // Called when a request streams events. These types of requests break asset discovery because
  // they never finish loading, so we untrack them to signal idle after the first event.
  _handleEventSourceMessageReceived = async event => {
    let { requestId } = event;
    // wait for request to be sent
    await this.#requestsLifeCycleHandler.get(requestId).requestWillBeSent;
    let request = this.#requests.get(requestId);
    /* istanbul ignore else: race condition paranioa */
    if (request) this._forgetRequest(request);
  }

  // Called when a request has finished loading which triggers the this.onrequestfinished
  // callback. The request should have an associated response and be finished with any redirects.
  _handleLoadingFinished = async event => {
    let { requestId } = event;
    // wait for upto 2 seconds or check if response has been sent
    await this.#requestsLifeCycleHandler.get(requestId).responseReceived;
    let request = this.#requests.get(requestId);
    /* istanbul ignore if: race condition paranioa */
    if (!request) return;

    await saveResponseResource(this, request);
    this._forgetRequest(request);
  }

  // Called when a request has failed loading and triggers the this.onrequestfailed callback.
  _handleLoadingFailed = async event => {
    let { requestId } = event;
    // wait for request to be sent
    // note: we are waiting on requestWillBeSent and NOT responseReceived
    // since, requests can be cancelled in-flight without Network.responseReceived having been triggered
    // and in any case, order of processing for responseReceived and loadingFailed does not matter, as response capturing is done in loadingFinished
    await this.#requestsLifeCycleHandler.get(requestId).requestWillBeSent;
    let request = this.#requests.get(event.requestId);
    /* istanbul ignore if: race condition paranioa */
    if (!request) return;

    // If request was aborted, keep track of it as we need to cancel any in process callbacks for
    // such a request to avoid Invalid InterceptionId errors
    // Note: 404s also show up under ERR_ABORTED and not ERR_FAILED
    if (event.errorText === 'net::ERR_ABORTED') {
      let message = `Request aborted for ${request.url}: ${event.errorText}`;
      this.log.debug(message, { ...this.meta, url: request.url });
      this.#aborted.add(request.requestId);
    } else if (event.errorText !== 'net::ERR_FAILED') {
      // do not log generic messages since the real error was likely logged elsewhere
      let message = `Request failed for ${request.url}: ${event.errorText}`;
      this.log.debug(message, { ...this.meta, url: request.url });
    }

    this._forgetRequest(request);
  }

  _initializeNetworkIdleWaitTimeout() {
    if (Network.TIMEOUT) return;

    Network.TIMEOUT = parseInt(process.env.PERCY_NETWORK_IDLE_WAIT_TIMEOUT) || 30000;

    if (Network.TIMEOUT > 60000) {
      this.log.warn('Setting PERCY_NETWORK_IDLE_WAIT_TIMEOUT over 60000ms is not recommended. ' +
        'If your page needs more than 60000ms to idle due to CPU/Network load, ' +
        'its recommended to increase CI resources where this cli is running.');
    }
  }
}

// Returns the normalized origin URL of a request
function originURL(request) {
  return normalizeURL((request.redirectChain[0] || request).url);
}

// Send a response for a given request, responding with cached resources when able
async function sendResponseResource(network, request, session) {
  let { disallowedHostnames, disableCache } = network.intercept;

  let log = network.log;
  let url = originURL(request);
  let meta = { ...network.meta, url };
  let send = (method, params) => network.send(session, method, params);

  try {
    let resource = network.intercept.getResource(url);
    network.log.debug(`Handling request: ${url}`, meta);

    if (!resource?.root && hostnameMatches(disallowedHostnames, url)) {
      log.debug('- Skipping disallowed hostname', meta);

      await send('Fetch.failRequest', {
        requestId: request.interceptId,
        errorReason: 'Aborted'
      });
    } else if (resource && (resource.root || resource.provided || !disableCache)) {
      log.debug(resource.root ? '- Serving root resource' : '- Resource cache hit', meta);

      await send('Fetch.fulfillRequest', {
        requestId: request.interceptId,
        responseCode: resource.status || 200,
        body: Buffer.from(resource.content).toString('base64'),
        responseHeaders: Object.entries(resource.headers || {})
          .map(([k, v]) => ({ name: k.toLowerCase(), value: String(v) }))
      });
    } else {
      await send('Fetch.continueRequest', {
        requestId: request.interceptId
      });
    }
  } catch (error) {
    /* istanbul ignore next: too hard to test (create race condition) */
    if (session.closing && error.message.includes('close')) return;

    // if failure is due to an already aborted request, ignore it
    // due to race condition we might get aborted event later and see a `Invalid InterceptionId`
    // error before, in which case we should wait for a tick and check again
    // Note: its not a necessity that we would get aborted callback in a tick, its just that if we
    // already have it then we can safely ignore this error
    // Its very hard to test it as this function should be called and request should get cancelled before
    if (error.message === ABORTED_MESSAGE || error.message.includes('Invalid InterceptionId')) {
      // defer this to the end of queue to make sure that any incoming aborted messages were
      // handled and network.#aborted is updated
      await new Promise((res, _) => process.nextTick(res));
      /* istanbul ignore else: too hard to create race where abortion event is delayed */
      if (network.isAborted(request.requestId)) {
        log.debug(`Ignoring further steps for ${url} as request was aborted by the browser.`);
        return;
      }
    }

    log.debug(`Encountered an error handling request: ${url}`, meta);
    log.debug(error);

    /* istanbul ignore next: catch race condition */
    await send('Fetch.failRequest', {
      requestId: request.interceptId,
      errorReason: 'Failed'
    }).catch(e => log.debug(e, meta));
  }
}

// Make a new request with Node based on a network request
function makeDirectRequest(network, request) {
  let headers = { ...request.headers };

  if (network.authorization?.username) {
    // include basic authorization username and password
    let { username, password } = network.authorization;
    let token = Buffer.from([username, password || ''].join(':')).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }

  return makeRequest(request.url, { buffer: true, headers });
}

// Save a resource from a request, skipping it if specific paramters are not met
async function saveResponseResource(network, request) {
  let { disableCache, allowedHostnames, enableJavaScript } = network.intercept;

  let log = network.log;
  let url = originURL(request);
  let response = request.response;
  let meta = { ...network.meta, url };
  let resource = network.intercept.getResource(url);

  if (!resource || (!resource.root && !resource.provided && disableCache)) {
    try {
      log.debug(`Processing resource: ${url}`, meta);
      let shouldCapture = response && hostnameMatches(allowedHostnames, url);
      let body = shouldCapture && await response.buffer();

      /* istanbul ignore if: first check is a sanity check */
      if (!response) {
        return log.debug('- Skipping no response', meta);
      } else if (!shouldCapture) {
        return log.debug('- Skipping remote resource', meta);
      } else if (!body.length) {
        return log.debug('- Skipping empty response', meta);
      } else if (body.length > MAX_RESOURCE_SIZE) {
        return log.debug('- Skipping resource larger than 25MB', meta);
      } else if (!ALLOWED_STATUSES.includes(response.status)) {
        return log.debug(`- Skipping disallowed status [${response.status}]`, meta);
      } else if (!enableJavaScript && !ALLOWED_RESOURCES.includes(request.type)) {
        return log.debug(`- Skipping disallowed resource type [${request.type}]`, meta);
      }

      // mime package does not handle query params
      let urlObj = new URL(url);
      let urlWithoutSearchParams = urlObj.origin + urlObj.pathname;
      let detectedMime = mime.lookup(urlWithoutSearchParams);
      let mimeType = (
        // ensure the mimetype is correct for text/plain responses
        response.mimeType === 'text/plain' && detectedMime
      ) || response.mimeType;

      // if we detect a font mime, we dont want to override it as different browsers may behave
      // differently for incorrect mimetype in font response, but we want to treat it as a
      // font anyway as font responses from the browser may not be properly encoded,
      // so request them directly.
      if (mimeType?.includes('font') || (detectedMime && detectedMime.includes('font'))) {
        log.debug('- Requesting asset directly');
        body = await makeDirectRequest(network, request);
      }

      resource = createResource(url, body, mimeType, {
        status: response.status,
        // 'Network.responseReceived' returns headers split by newlines, however
        // `Fetch.fulfillRequest` (used for cached responses) will hang with newlines.
        headers: Object.entries(response.headers).reduce((norm, [key, value]) => (
          Object.assign(norm, { [key]: value.split('\n') })
        ), {})
      });

      log.debug(`- sha: ${resource.sha}`, meta);
      log.debug(`- mimetype: ${resource.mimetype}`, meta);
    } catch (error) {
      log.debug(`Encountered an error processing resource: ${url}`, meta);
      log.debug(error);
    }
  }

  if (resource) {
    network.intercept.saveResource(resource);
  }
}

export default Network;
