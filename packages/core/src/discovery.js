import logger from '@percy/logger';
import Queue from './queue.js';
import {
  normalizeURL,
  hostnameMatches,
  createResource,
  createRootResource,
  createPercyCSSResource,
  createLogResource,
  yieldAll
} from './utils.js';

// Logs verbose debug logs detailing various snapshot options.
function debugSnapshotOptions(snapshot) {
  let log = logger('core:snapshot');

  // log snapshot info
  log.debug('---------', snapshot.meta);
  log.debug(`Received snapshot: ${snapshot.name}`, snapshot.meta);

  // will log debug info for an object property if its value is defined
  let debugProp = (obj, prop, format = String) => {
    let val = prop.split('.').reduce((o, k) => o?.[k], obj);

    if (val != null) {
      // join formatted array values with a space
      val = [].concat(val).map(format).join(', ');
      log.debug(`- ${prop}: ${val}`, snapshot.meta);
    }
  };

  debugProp(snapshot, 'url');
  debugProp(snapshot, 'scope');
  debugProp(snapshot, 'widths', v => `${v}px`);
  debugProp(snapshot, 'minHeight', v => `${v}px`);
  debugProp(snapshot, 'enableJavaScript');
  debugProp(snapshot, 'cliEnableJavaScript');
  debugProp(snapshot, 'disableShadowDOM');
  debugProp(snapshot, 'enableLayout');
  debugProp(snapshot, 'domTransformation');
  debugProp(snapshot, 'reshuffleInvalidTags');
  debugProp(snapshot, 'deviceScaleFactor');
  debugProp(snapshot, 'waitForTimeout');
  debugProp(snapshot, 'waitForSelector');
  debugProp(snapshot, 'scopeOptions.scroll');
  debugProp(snapshot, 'execute.afterNavigation');
  debugProp(snapshot, 'execute.beforeResize');
  debugProp(snapshot, 'execute.afterResize');
  debugProp(snapshot, 'execute.beforeSnapshot');
  debugProp(snapshot, 'discovery.allowedHostnames');
  debugProp(snapshot, 'discovery.disallowedHostnames');
  debugProp(snapshot, 'discovery.devicePixelRatio');
  debugProp(snapshot, 'discovery.requestHeaders', JSON.stringify);
  debugProp(snapshot, 'discovery.authorization', JSON.stringify);
  debugProp(snapshot, 'discovery.disableCache');
  debugProp(snapshot, 'discovery.captureMockedServiceWorker');
  debugProp(snapshot, 'discovery.userAgent');
  debugProp(snapshot, 'clientInfo');
  debugProp(snapshot, 'environmentInfo');
  debugProp(snapshot, 'domSnapshot', Boolean);

  for (let added of (snapshot.additionalSnapshots || [])) {
    log.debug(`Additional snapshot: ${added.name}`, snapshot.meta);
    debugProp(added, 'waitForTimeout');
    debugProp(added, 'waitForSelector');
    debugProp(added, 'execute');
  }
}

// Wait for a page's asset discovery network to idle
function waitForDiscoveryNetworkIdle(page, options) {
  let { allowedHostnames, networkIdleTimeout } = options;
  let filter = r => hostnameMatches(allowedHostnames, r.url);

  return page.network.idle(filter, networkIdleTimeout);
}

// Creates an initial resource map for a snapshot containing serialized DOM
function parseDomResources({ url, domSnapshot }) {
  if (!domSnapshot) return new Map();
  let isHTML = typeof domSnapshot === 'string';
  let { html, resources = [] } = isHTML ? { html: domSnapshot } : domSnapshot;
  let rootResource = createRootResource(url, html);

  // reduce the array of resources into a keyed map
  return resources.reduce((map, { url, content, mimetype }) => {
    // serialized resource contents are base64 encoded
    content = Buffer.from(content, mimetype.includes('text') ? 'utf8' : 'base64');
    // specify the resource as provided to prevent overwriting during asset discovery
    let resource = createResource(url, content, mimetype, { provided: true });
    // key the resource by its url and return the map
    return map.set(resource.url, resource);
    // the initial map is created with at least a root resource
  }, new Map([[rootResource.url, rootResource]]));
}

// Calls the provided callback with additional resources
function processSnapshotResources({ domSnapshot, resources, ...snapshot }) {
  let log = logger('core:snapshot');
  resources = [...(resources?.values() ?? [])];

  // find any root resource matching the provided dom snapshot
  let rootContent = domSnapshot?.html ?? domSnapshot;
  let root = resources.find(r => r.content === rootContent);

  // initialize root resources if needed
  if (!root) {
    let domResources = parseDomResources({ ...snapshot, domSnapshot });
    resources = [...domResources.values(), ...resources];
    root = resources[0];
  }

  // inject Percy CSS
  if (snapshot.percyCSS) {
    // check @percy/dom/serialize-dom.js
    let domSnapshotHints = domSnapshot?.hints ?? [];
    if (domSnapshotHints.includes('DOM elements found outside </body>')) {
      log.warn('DOM elements found outside </body>, percyCSS might not work');
    }

    let css = createPercyCSSResource(root.url, snapshot.percyCSS);
    resources.push(css);

    // replace root contents and associated properties
    Object.assign(root, createRootResource(root.url, (
      root.content.replace(/(<\/body>)(?!.*\1)/is, (
        `<link data-percy-specific-css rel="stylesheet" href="${css.pathname}"/>`
      ) + '$&'))));
  }

  // include associated snapshot logs matched by meta information
  resources.push(createLogResource(logger.query(log => (
    log.meta.snapshot?.name === snapshot.meta.snapshot.name
  ))));

  return { ...snapshot, resources };
}

// Triggers the capture of resource requests for a page by iterating over snapshot widths to resize
// the page and calling any provided execute options.
async function* captureSnapshotResources(page, snapshot, options) {
  let { discovery, additionalSnapshots = [], ...baseSnapshot } = snapshot;
  let { capture, captureWidths, deviceScaleFactor, mobile } = options;

  // used to take snapshots and remove any discovered root resource
  let takeSnapshot = async (options, width) => {
    if (captureWidths) options = { ...options, width };
    let captured = await page.snapshot(options);
    captured.resources.delete(normalizeURL(captured.url));
    capture(processSnapshotResources(captured));
    return captured;
  };

  // used to resize the using capture options
  let resizePage = width => page.resize({
    height: snapshot.minHeight,
    deviceScaleFactor,
    mobile,
    width
  });

  // navigate to the url
  yield resizePage(snapshot.widths[0]);
  yield page.goto(snapshot.url);

  if (snapshot.execute) {
    // when any execute options are provided, inject snapshot options
    /* istanbul ignore next: cannot detect coverage of injected code */
    yield page.eval((_, s) => (window.__PERCY__.snapshot = s), snapshot);
    yield page.evaluate(snapshot.execute.afterNavigation);
  }

  // iterate over additional snapshots for proper DOM capturing
  for (let additionalSnapshot of [baseSnapshot, ...additionalSnapshots]) {
    let isBaseSnapshot = additionalSnapshot === baseSnapshot;
    let snap = { ...baseSnapshot, ...additionalSnapshot };
    let { widths, execute } = snap;
    let [width] = widths;

    // iterate over widths to trigger reqeusts and capture other widths
    if (isBaseSnapshot || captureWidths) {
      for (let i = 0; i < widths.length - 1; i++) {
        if (captureWidths) yield takeSnapshot(snap, width);
        yield page.evaluate(execute?.beforeResize);
        yield waitForDiscoveryNetworkIdle(page, discovery);
        yield resizePage(width = widths[i + 1]);
        yield page.evaluate(execute?.afterResize);
      }
    }

    if (capture && !snapshot.domSnapshot) {
      // capture this snapshot and update the base snapshot after capture
      let captured = yield takeSnapshot(snap, width);
      if (isBaseSnapshot) baseSnapshot = captured;

      // resize back to the initial width when capturing additional snapshot widths
      if (captureWidths && additionalSnapshots.length) {
        let l = additionalSnapshots.indexOf(additionalSnapshot) + 1;
        if (l < additionalSnapshots.length) yield resizePage(snapshot.widths[0]);
      }
    }
  }

  // recursively trigger resource requests for any alternate device pixel ratio
  if (deviceScaleFactor !== discovery.devicePixelRatio) {
    yield waitForDiscoveryNetworkIdle(page, discovery);

    yield* captureSnapshotResources(page, snapshot, {
      deviceScaleFactor: discovery.devicePixelRatio,
      mobile: true
    });
  }

  // wait for final network idle when not capturing DOM
  if (capture && snapshot.domSnapshot) {
    yield waitForDiscoveryNetworkIdle(page, discovery);
    capture(processSnapshotResources(snapshot));
  }
}

// Pushes all provided snapshots to a discovery queue with the provided callback, yielding to each
// one concurrently. When skipping asset discovery, the callback is called immediately for each
// snapshot, also processing snapshot resources when not dry-running.
export async function* discoverSnapshotResources(queue, options, callback) {
  let { snapshots, skipDiscovery, dryRun } = options;

  yield* yieldAll(snapshots.reduce((all, snapshot) => {
    debugSnapshotOptions(snapshot);

    if (skipDiscovery) {
      let { additionalSnapshots, ...baseSnapshot } = snapshot;
      additionalSnapshots = (dryRun && additionalSnapshots) || [];

      for (let snap of [baseSnapshot, ...additionalSnapshots]) {
        callback(dryRun ? snap : processSnapshotResources(snap));
      }
    } else {
      all.push(queue.push(snapshot, callback));
    }

    return all;
  }, []));
}

// Used to cache resources across core instances
export const RESOURCE_CACHE_KEY = Symbol('resource-cache');

// Creates an asset discovery queue that uses the percy browser instance to create a page for each
// snapshot which is used to intercept and capture snapshot resource requests.
export function createDiscoveryQueue(percy) {
  let { concurrency } = percy.config.discovery;
  let queue = new Queue('discovery');
  let cache;

  return queue
    .set({ concurrency })
  // on start, launch the browser and run the queue
    .handle('start', async () => {
      cache = percy[RESOURCE_CACHE_KEY] = new Map();
      await percy.browser.launch();
      queue.run();
    })
  // on end, close the browser
    .handle('end', async () => {
      await percy.browser.close();
    })
  // snapshots are unique by name; when deferred also by widths
    .handle('find', ({ name, widths }, snapshot) => (
      snapshot.name === name && (!percy.deferUploads || (
        !widths || widths.join() === snapshot.widths.join()))
    ))
  // initialize the resources for DOM snapshots
    .handle('push', snapshot => {
      let resources = parseDomResources(snapshot);
      return { ...snapshot, resources };
    })
  // discovery resources for snapshots and call the callback for each discovered snapshot
    .handle('task', async function*(snapshot, callback) {
      percy.log.debug(`Discovering resources: ${snapshot.name}`, snapshot.meta);

      // expectation explained in tests
      /* istanbul ignore next: tested, but coverage is stripped */
      let assetDiscoveryPageEnableJS = (snapshot.cliEnableJavaScript && !snapshot.domSnapshot) || (snapshot.enableJavaScript ?? !snapshot.domSnapshot);

      percy.log.debug(`Asset discovery Browser Page enable JS: ${assetDiscoveryPageEnableJS}`);
      // create a new browser page
      let page = yield percy.browser.page({
        enableJavaScript: assetDiscoveryPageEnableJS,
        networkIdleTimeout: snapshot.discovery.networkIdleTimeout,
        requestHeaders: snapshot.discovery.requestHeaders,
        authorization: snapshot.discovery.authorization,
        userAgent: snapshot.discovery.userAgent,
        captureMockedServiceWorker: snapshot.discovery.captureMockedServiceWorker,
        meta: snapshot.meta,

        // enable network inteception
        intercept: {
          enableJavaScript: snapshot.enableJavaScript,
          disableCache: snapshot.discovery.disableCache,
          allowedHostnames: snapshot.discovery.allowedHostnames,
          disallowedHostnames: snapshot.discovery.disallowedHostnames,
          getResource: u => snapshot.resources.get(u) || cache.get(u),
          saveResource: r => { snapshot.resources.set(r.url, r); if (!r.root) { cache.set(r.url, r); } }
        }
      });

      try {
        yield* captureSnapshotResources(page, snapshot, {
          captureWidths: !snapshot.domSnapshot && percy.deferUploads,
          capture: callback
        });
      } finally {
        // always close the page when done
        await page.close();
      }
    })
    .handle('error', ({ name, meta }, error) => {
      if (error.name === 'AbortError' && queue.readyState < 3) {
        // only error about aborted snapshots when not closed
        percy.log.error('Received a duplicate snapshot, ' + (
          `the previous snapshot was aborted: ${name}`), meta);
      } else {
        // log all other encountered errors
        percy.log.error(`Encountered an error taking snapshot: ${name}`, meta);
        percy.log.error(error, meta);
      }
    });
}
