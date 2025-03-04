import fs from 'fs';
import PercyEnv from '@percy/env';
import { git } from '@percy/env/utils';
import logger from '@percy/logger';

import {
  pool,
  request,
  sha256hash,
  base64encode,
  getPackageJSON,
  waitForTimeout
} from './utils.js';

// Default client API URL can be set with an env var for API development
const { PERCY_CLIENT_API_URL = 'https://percy.io/api/v1' } = process.env;
const pkg = getPackageJSON(import.meta.url);
// minimum polling interval milliseconds
const MIN_POLLING_INTERVAL = 1_000;

// Validate ID arguments
function validateId(type, id) {
  if (!id) throw new Error(`Missing ${type} ID`);
  if (!(typeof id === 'string' || typeof id === 'number')) {
    throw new Error(`Invalid ${type} ID`);
  }
}

// Validate project path arguments
function validateProjectPath(path) {
  if (!path) throw new Error('Missing project path');
  if (!/^[^/]+?\/.+/.test(path)) {
    throw new Error(`Invalid project path. Expected "org/project" but received "${path}"`);
  }
}

// PercyClient is used to communicate with the Percy API to create and finalize
// builds and snapshot. Uses @percy/env to collect environment information used
// during build creation.
export class PercyClient {
  log = logger('client');
  env = new PercyEnv(process.env);
  clientInfo = new Set();
  environmentInfo = new Set();

  constructor({
    // read or write token, defaults to PERCY_TOKEN environment variable
    token,
    // initial user agent info
    clientInfo,
    environmentInfo,
    config,
    // versioned api url
    apiUrl = PERCY_CLIENT_API_URL
  } = {}) {
    Object.assign(this, { token, config: config || {}, apiUrl });
    this.addClientInfo(clientInfo);
    this.addEnvironmentInfo(environmentInfo);
  }

  // Adds additional unique client info.
  addClientInfo(info) {
    for (let i of [].concat(info)) {
      if (i) this.clientInfo.add(i);
    }
  }

  // Adds additional unique environment info.
  addEnvironmentInfo(info) {
    for (let i of [].concat(info)) {
      if (i) this.environmentInfo.add(i);
    }
  }

  // Stringifies client and environment info.
  userAgent() {
    let client = new Set([`Percy/${/\w+$/.exec(this.apiUrl)}`]
      .concat(`${pkg.name}/${pkg.version}`, ...this.clientInfo)
      .filter(Boolean));
    let environment = new Set([...this.environmentInfo]
      .concat(`node/${process.version}`, this.env.info)
      .filter(Boolean));

    return `${[...client].join(' ')} (${[...environment].join('; ')})`;
  }

  // Checks for a Percy token and returns it.
  // Priority order is
  // 1. passed token to constructor
  // 2. PERCY_TOKEN env var [ from env package ]
  // 3. token from percy config
  getToken(raiseIfMissing = true) {
    let token = this.token || this.env.token || this.config.percy?.token;
    if (!token && raiseIfMissing) throw new Error('Missing Percy token');
    return token;
  }

  // Returns common headers used for each request with additional
  // headers. Throws an error when the token is missing, which is a required
  // authorization header.
  headers(headers) {
    return Object.assign({
      Authorization: `Token token=${this.getToken()}`,
      'User-Agent': this.userAgent()
    }, headers);
  }

  // Performs a GET request for an API endpoint with appropriate headers.
  get(path) {
    return request(`${this.apiUrl}/${path}`, {
      headers: this.headers(),
      method: 'GET'
    });
  }

  // Performs a POST request to a JSON API endpoint with appropriate headers.
  post(path, body = {}) {
    return request(`${this.apiUrl}/${path}`, {
      headers: this.headers({ 'Content-Type': 'application/vnd.api+json' }),
      method: 'POST',
      body
    });
  }

  // Creates a build with optional build resources. Only one build can be
  // created at a time per instance so snapshots and build finalization can be
  // done more seemlessly without manually tracking build ids
  async createBuild({ resources = [], projectType } = {}) {
    this.log.debug('Creating a new build...');

    return this.post('builds', {
      data: {
        type: 'builds',
        attributes: {
          type: projectType,
          branch: this.env.git.branch,
          'target-branch': this.env.target.branch,
          'target-commit-sha': this.env.target.commit,
          'commit-sha': this.env.git.sha,
          'commit-committed-at': this.env.git.committedAt,
          'commit-author-name': this.env.git.authorName,
          'commit-author-email': this.env.git.authorEmail,
          'commit-committer-name': this.env.git.committerName,
          'commit-committer-email': this.env.git.committerEmail,
          'commit-message': this.env.git.message,
          'pull-request-number': this.env.pullRequest,
          'parallel-nonce': this.env.parallel.nonce,
          'parallel-total-shards': this.env.parallel.total,
          partial: this.env.partial
        },
        relationships: {
          resources: {
            data: resources.map(r => ({
              type: 'resources',
              id: r.sha || sha256hash(r.content),
              attributes: {
                'resource-url': r.url,
                'is-root': r.root || null,
                mimetype: r.mimetype || null
              }
            }))
          }
        }
      }
    });
  }

  // Finalizes the active build. When `all` is true, `all-shards=true` is
  // added as a query param so the API finalizes all other build shards.
  async finalizeBuild(buildId, { all = false } = {}) {
    validateId('build', buildId);
    let qs = all ? 'all-shards=true' : '';
    this.log.debug(`Finalizing build ${buildId}...`);
    return this.post(`builds/${buildId}/finalize?${qs}`);
  }

  // Retrieves build data by id. Requires a read access token.
  async getBuild(buildId) {
    validateId('build', buildId);
    this.log.debug(`Get build ${buildId}`);
    return this.get(`builds/${buildId}`);
  }

  // Retrieves project builds optionally filtered. Requires a read access token.
  async getBuilds(project, filters = {}) {
    validateProjectPath(project);

    let qs = Object.keys(filters).map(k => (
      Array.isArray(filters[k])
        ? filters[k].map(v => `filter[${k}][]=${v}`).join('&')
        : `filter[${k}]=${filters[k]}`
    )).join('&');

    this.log.debug(`Fetching builds for ${project}`);
    return this.get(`projects/${project}/builds?${qs}`);
  }

  // Resolves when the build has finished and is no longer pending or
  // processing. By default, will time out if no update after 10 minutes.
  waitForBuild({
    build,
    project,
    commit,
    timeout = 10 * 60 * 1000,
    interval = 10_000
  }, onProgress) {
    if (interval < MIN_POLLING_INTERVAL) {
      this.log.warn(`Ignoring interval since it cannot be less than ${MIN_POLLING_INTERVAL}ms.`);
      interval = MIN_POLLING_INTERVAL;
    }
    if (!project && commit) {
      throw new Error('Missing project path for commit');
    } else if (!project && !build) {
      throw new Error('Missing project path or build ID');
    } else if (project) {
      validateProjectPath(project);
    }

    commit ||= this.env.git.sha;
    if (!build && !commit) throw new Error('Missing build commit');
    let sha = commit && (git(`rev-parse ${commit}`) || commit);

    let fetchData = async () => build
      ? (await this.getBuild(build)).data
      : (await this.getBuilds(project, { sha })).data?.[0];

    this.log.debug(`Waiting for build ${build || `${project} (${commit})`}...`);

    // recursively poll every second until the build finishes
    return new Promise((resolve, reject) => (async function poll(last, t) {
      try {
        let data = await fetchData();
        let state = data?.attributes.state;
        let pending = !state || state === 'pending' || state === 'processing';
        let updated = JSON.stringify(data) !== JSON.stringify(last);

        // new data received
        if (updated) {
          t = Date.now();

        // no new data within the timeout
        } else if (Date.now() - t >= timeout) {
          throw new Error(state == null ? 'Build not found' : 'Timeout exceeded with no updates');
        }

        // call progress every update after the first update
        if ((last || pending) && updated) {
          onProgress?.(data);
        }

        // not finished, poll again
        if (pending) {
          return setTimeout(poll, interval, data, t);

        // build finished
        } else {
          // ensure progress is called at least once
          if (!last) onProgress?.(data);
          resolve({ data });
        }
      } catch (err) {
        reject(err);
      }
    })(null, Date.now()));
  }

  // Uploads a single resource to the active build. If `filepath` is provided,
  // `content` is read from the filesystem. The sha is optional and will be
  // created from `content` if one is not provided.
  async uploadResource(buildId, { url, sha, filepath, content } = {}) {
    validateId('build', buildId);
    this.log.debug(`Uploading resource: ${url}...`);
    if (filepath) content = await fs.promises.readFile(filepath);

    return this.post(`builds/${buildId}/resources`, {
      data: {
        type: 'resources',
        id: sha || sha256hash(content),
        attributes: {
          'base64-content': base64encode(content)
        }
      }
    });
  }

  // Uploads resources to the active build concurrently, two at a time.
  async uploadResources(buildId, resources) {
    validateId('build', buildId);
    this.log.debug(`Uploading resources for ${buildId}...`);

    return pool(function*() {
      for (let resource of resources) {
        yield this.uploadResource(buildId, resource);
      }
    }, this, 2);
  }

  // Creates a snapshot for the active build using the provided attributes.
  async createSnapshot(buildId, {
    name,
    widths,
    scope,
    scopeOptions,
    minHeight,
    enableJavaScript,
    enableLayout,
    clientInfo,
    environmentInfo,
    resources = []
  } = {}) {
    validateId('build', buildId);
    this.addClientInfo(clientInfo);
    this.addEnvironmentInfo(environmentInfo);

    if (!this.clientInfo.size || !this.environmentInfo.size) {
      this.log.warn('Warning: Missing `clientInfo` and/or `environmentInfo` properties');
    }

    this.log.debug(`Creating snapshot: ${name}...`);

    for (let resource of resources) {
      if (resource.sha || resource.content || !resource.filepath) continue;
      resource.content = await fs.promises.readFile(resource.filepath);
    }

    return this.post(`builds/${buildId}/snapshots`, {
      data: {
        type: 'snapshots',
        attributes: {
          name: name || null,
          widths: widths || null,
          scope: scope || null,
          'scope-options': scopeOptions || {},
          'minimum-height': minHeight || null,
          'enable-javascript': enableJavaScript || null,
          'enable-layout': enableLayout || false
        },
        relationships: {
          resources: {
            data: resources.map(r => ({
              type: 'resources',
              id: r.sha ?? (r.content && sha256hash(r.content)),
              attributes: {
                'resource-url': r.url || null,
                'is-root': r.root || null,
                'for-widths': r.widths || null,
                mimetype: r.mimetype || null
              }
            }))
          }
        }
      }
    });
  }

  // Finalizes a snapshot.
  async finalizeSnapshot(snapshotId) {
    validateId('snapshot', snapshotId);
    this.log.debug(`Finalizing snapshot ${snapshotId}...`);
    return this.post(`snapshots/${snapshotId}/finalize`);
  }

  // Convenience method for creating a snapshot for the active build, uploading
  // missing resources for the snapshot, and finalizing the snapshot.
  async sendSnapshot(buildId, options) {
    let snapshot = await this.createSnapshot(buildId, options);
    let missing = snapshot.data.relationships?.['missing-resources']?.data;

    if (missing?.length) {
      let resources = options.resources.reduce((acc, r) => Object.assign(acc, { [r.sha]: r }), {});
      await this.uploadResources(buildId, missing.map(({ id }) => resources[id]));
    }

    await this.finalizeSnapshot(snapshot.data.id);
    return snapshot;
  }

  async createComparison(snapshotId, { tag, tiles = [], externalDebugUrl, ignoredElementsData, domInfoSha, consideredElementsData, metadata } = {}) {
    validateId('snapshot', snapshotId);
    // Remove post percy api deploy
    this.log.debug(`Creating comparision: ${tag.name}...`);

    for (let tile of tiles) {
      if (tile.sha) continue;
      if (tile.content && typeof tile.content === 'string') {
        // base64 encoded content coming from SDK
        tile.content = Buffer.from(tile.content, 'base64');
      } else if (tile.filepath) {
        tile.content = await fs.promises.readFile(tile.filepath);
      }
    }

    return this.post(`snapshots/${snapshotId}/comparisons`, {
      data: {
        type: 'comparisons',
        attributes: {
          'external-debug-url': externalDebugUrl || null,
          'ignore-elements-data': ignoredElementsData || null,
          'consider-elements-data': consideredElementsData || null,
          'dom-info-sha': domInfoSha || null,
          metadata: metadata || null
        },
        relationships: {
          tag: {
            data: {
              type: 'tag',
              attributes: {
                name: tag.name || null,
                width: tag.width || null,
                height: tag.height || null,
                'os-name': tag.osName || null,
                'os-version': tag.osVersion || null,
                orientation: tag.orientation || null,
                'browser-name': tag.browserName || null,
                'browser-version': tag.browserVersion || null,
                resolution: tag.resolution || null
              }
            }
          },
          tiles: {
            data: tiles.map(t => ({
              type: 'tiles',
              attributes: {
                sha: t.sha || (t.content && sha256hash(t.content)),
                'status-bar-height': t.statusBarHeight || null,
                'nav-bar-height': t.navBarHeight || null,
                'header-height': t.headerHeight || null,
                'footer-height': t.footerHeight || null,
                fullscreen: t.fullscreen || null
              }
            }))
          }
        }
      }
    });
  }

  async uploadComparisonTile(comparisonId, { index = 0, total = 1, filepath, content, sha } = {}) {
    validateId('comparison', comparisonId);
    this.log.debug(`Uploading comparison tile: ${index + 1}/${total} (${comparisonId})...`);
    if (filepath && !content) content = await fs.promises.readFile(filepath);
    if (sha) {
      return await this.verify(comparisonId, sha);
    }

    return this.post(`comparisons/${comparisonId}/tiles`, {
      data: {
        type: 'tiles',
        attributes: {
          'base64-content': base64encode(content),
          index
        }
      }
    });
  }

  // Convenience method for verifying if tile is present
  async verify(comparisonId, sha) {
    let retries = 10;
    let success = null;
    do {
      await waitForTimeout(500);
      success = await this.verifyComparisonTile(comparisonId, sha);
      retries -= 1;
    }
    while (retries > 0 && !success);

    if (!success) {
      this.log.error('Uploading comparison tile failed');
      return false;
    }
    return true;
  }

  async verifyComparisonTile(comparisonId, sha) {
    validateId('comparison', comparisonId);
    this.log.debug(`Verifying comparison tile with sha: ${sha}`);

    try {
      return await this.post(`comparisons/${comparisonId}/tiles/verify`, {
        data: {
          type: 'tiles',
          attributes: {
            sha: sha
          }
        }
      });
    } catch (error) {
      if (error.response.statusCode === 400) {
        return false;
      }
      throw error;
    }
  }

  async uploadComparisonTiles(comparisonId, tiles) {
    validateId('comparison', comparisonId);
    this.log.debug(`Uploading comparison tiles for ${comparisonId}...`);

    return pool(function*() {
      for (let index = 0; index < tiles.length; index++) {
        yield this.uploadComparisonTile(comparisonId, {
          index, total: tiles.length, ...tiles[index]
        });
      }
    }, this, 2);
  }

  async finalizeComparison(comparisonId) {
    validateId('comparison', comparisonId);
    this.log.debug(`Finalizing comparison ${comparisonId}...`);
    return this.post(`comparisons/${comparisonId}/finalize`);
  }

  async sendComparison(buildId, options) {
    let snapshot = await this.createSnapshot(buildId, options);
    let comparison = await this.createComparison(snapshot.data.id, options);
    await this.uploadComparisonTiles(comparison.data.id, options.tiles);
    await this.finalizeComparison(comparison.data.id);
    return comparison;
  }

  async sendBuildEvents(buildId, body) {
    validateId('build', buildId);
    this.log.debug('Sending Build Events');
    return this.post(`builds/${buildId}/send-events`, {
      data: body
    });
  }

  // decides project type
  tokenType() {
    let token = this.getToken(false) || '';

    const type = token.split('_')[0];
    switch (type) {
      case 'auto':
        return 'automate';
      case 'web':
        return 'web';
      case 'app':
        return 'app';
      case 'ss':
        return 'generic';
      default:
        return 'web';
    }
  }
}

export default PercyClient;
