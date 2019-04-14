import FormData from 'form-data';
import fs from 'fs';
import got, { GotBodyOptions, GotFormOptions, GotJSONOptions, Response } from 'got';
import { Cookie } from 'tough-cookie';
import urljoin from 'url-join';

import {
  AllClientData,
  Label,
  NormalizedTorrent,
  TorrentClient,
  TorrentSettings,
  TorrentState,
} from '@ctrl/shared-torrent';

import {
  AddTorrentOptions,
  Torrent,
  TorrentFile,
  TorrentFilePriority,
  TorrentFilters,
  TorrentPieceState,
  TorrentProperties,
  TorrentState as qbtState,
  TorrentTrackers,
  WebSeed,
} from './types';

const defaults: TorrentSettings = {
  baseUrl: 'http://localhost:9091/',
  path: '/api/v2',
  username: '',
  password: '',
  timeout: 5000,
};

export class QBittorrent implements TorrentClient {
  config: TorrentSettings;

  /**
   * auth cookie
   */
  private _sid?: string;

  constructor(options: Partial<TorrentSettings> = {}) {
    this.config = { ...defaults, ...options };
  }

  /**
   * Get application version
   */
  async version(): Promise<string> {
    const res = await this.request<string>(
      '/app/version',
      'GET',
      undefined,
      undefined,
      undefined,
      false,
    );
    return res.body;
  }

  async getTorrent(hash: string): Promise<NormalizedTorrent> {
    const torrentsResponse = await this.listTorrents(hash);
    const torrentData = torrentsResponse[0];
    if (!torrentData) {
      throw new Error('Torrent not found');
    }

    return this._normalizeTorrentData(torrentData);
  }

  /**
   * Torrents list
   * @param hashes Filter by torrent hashes
   * @param [filter] Filter torrent list
   * @param category Get torrents with the given category (empty string means "without category"; no "category" parameter means "any category")
   * @returns list of torrents
   */
  async listTorrents(
    hashes?: string | string[],
    filter?: TorrentFilters,
    category?: string,
  ): Promise<Torrent[]> {
    const params: any = {};
    if (hashes) {
      params.hashes = this._normalizeHashes(hashes);
    }

    if (filter) {
      params.filter = filter;
    }

    if (category) {
      params.category = category;
    }

    const res = await this.request<Torrent[]>('/torrents/info', 'GET', params);
    return res.body;
  }

  async getAllData() {
    const listTorrents = await this.listTorrents();
    const results: AllClientData = {
      torrents: [],
      labels: [],
    };
    const labels: { [key: string]: Label } = {};
    for (const torrent of listTorrents) {
      const torrentData: NormalizedTorrent = this._normalizeTorrentData(torrent);
      results.torrents.push(torrentData);

      // setup label
      if (torrentData.label) {
        if (labels[torrentData.label]) {
          labels[torrentData.label] = {
            id: torrentData.label,
            name: torrentData.label,
            count: 1,
          };
        } else {
          labels[torrentData.label].count += 1;
        }
      }
    }

    return results;
  }

  async torrentProperties(hash: string): Promise<TorrentProperties> {
    const res = await this.request<TorrentProperties>('/torrents/properties', 'GET', { hash });
    return res.body;
  }

  async torrentTrackers(hash: string): Promise<TorrentTrackers[]> {
    const res = await this.request<TorrentTrackers[]>('/torrents/trackers', 'GET', { hash });
    return res.body;
  }

  async torrentWebSeeds(hash: string): Promise<WebSeed[]> {
    const res = await this.request<WebSeed[]>('/torrents/webseeds', 'GET', { hash });
    return res.body;
  }

  async torrentFiles(hash: string): Promise<TorrentFile[]> {
    const res = await this.request<TorrentFile[]>('/torrents/files', 'GET', { hash });
    return res.body;
  }

  async setFilePriority(
    hash: string,
    fileIds: string | string[],
    priority: TorrentFilePriority,
  ): Promise<TorrentFile[]> {
    const res = await this.request<TorrentFile[]>('/torrents/filePrio', 'GET', {
      hash,
      id: this._normalizeHashes(fileIds),
      priority,
    });
    return res.body;
  }

  async torrentPieceStates(hash: string): Promise<TorrentPieceState[]> {
    const res = await this.request<TorrentPieceState[]>('/torrents/pieceStates', 'GET', { hash });
    return res.body;
  }

  /**
   * Torrents piece hashes
   * @returns an array of hashes (strings) of all pieces (in order) of a specific torrent
   */
  async torrentPieceHashes(hash: string): Promise<string[]> {
    const res = await this.request<string[]>('/torrents/pieceHashes', 'GET', { hash });
    return res.body;
  }

  async setTorrentLocation(hashes: string | string[] | 'all', location: string): Promise<boolean> {
    const body = {
      hashes: this._normalizeHashes(hashes),
      location,
    };
    await this.request('/torrents/setLocation', 'POST', undefined, body);
    return true;
  }

  async setTorrentName(hashes: string | string[] | 'all', name: string): Promise<boolean> {
    const body = {
      hashes: this._normalizeHashes(hashes),
      name,
    };
    await this.request('/torrents/rename', 'POST', undefined, body);
    return true;
  }

  async createCategory(category: string): Promise<boolean> {
    const body = {
      category,
    };
    await this.request('/torrents/createCategory', 'POST', undefined, body);
    return true;
  }

  async removeCategory(category: string): Promise<boolean> {
    const body = {
      category,
    };
    await this.request('/torrents/removeCategories', 'POST', undefined, body);
    return true;
  }

  async setTorrentCategory(hashes: string | string[] | 'all', category: string): Promise<boolean> {
    const body = {
      hashes: this._normalizeHashes(hashes),
      category,
    };
    await this.request('/torrents/setCategory', 'POST', undefined, body);
    return true;
  }

  async pauseTorrent(hashes: string | string[] | 'all'): Promise<boolean> {
    const params = {
      hashes: this._normalizeHashes(hashes),
    };
    await this.request('/torrents/pause', 'GET', params);
    return true;
  }

  async resumeTorrent(hashes: string | string[] | 'all'): Promise<boolean> {
    const params = {
      hashes: this._normalizeHashes(hashes),
    };
    await this.request('/torrents/resume', 'GET', params);
    return true;
  }

  /**
   * @link https://github.com/qbittorrent/qBittorrent/wiki/Web-API-Documentation#delete-torrents
   */
  async removeTorrent(hashes: string | string[] | 'all', deleteFiles = true): Promise<boolean> {
    const params = {
      hashes: this._normalizeHashes(hashes),
      deleteFiles,
    };
    await this.request('/torrents/delete', 'GET', params);
    return true;
  }

  async recheckTorrent(hashes: string | string[] | 'all'): Promise<boolean> {
    const params = {
      hashes: this._normalizeHashes(hashes),
    };
    await this.request('/torrents/recheck', 'GET', params);
    return true;
  }

  async reannounceTorrent(hashes: string | string[] | 'all'): Promise<boolean> {
    const params = {
      hashes: this._normalizeHashes(hashes),
    };
    await this.request('/torrents/reannounce', 'GET', params);
    return true;
  }

  async addTorrent(
    torrent: string | Buffer,
    filename = 'torrent',
    options?: Partial<AddTorrentOptions>,
  ): Promise<boolean> {
    const form = new FormData();
    const fileOptions: FormData.AppendOptions = {
      contentType: 'application/x-bittorrent',
      filename,
    };

    if (typeof torrent === 'string') {
      if (fs.existsSync(torrent)) {
        form.append('file', Buffer.from(fs.readFileSync(torrent)), fileOptions);
      } else {
        form.append('file', Buffer.from(torrent, 'base64'), fileOptions);
      }
    } else {
      form.append('file', torrent, fileOptions);
    }

    if (options) {
      for (const key of Object.keys(options)) {
        form.append(key, options[key]);
      }
    }

    const res = await this.request<string>(
      '/torrents/add',
      'POST',
      undefined,
      form,
      form.getHeaders(),
      false,
    );

    if (res.body === 'Fails.') {
      throw new Error('Failed to add torrent');
    }

    return true;
  }

  async addTrackers(hash: string, urls: string): Promise<boolean> {
    const params = { hash, urls };
    await this.request('/torrents/addTrackers', 'GET', params);
    return true;
  }

  async editTrackers(hash: string, origUrl: string, newUrl: string): Promise<boolean> {
    const params = { hash, origUrl, newUrl };
    await this.request('/torrents/editTrackers', 'GET', params);
    return true;
  }

  async removeTrackers(hash: string, urls: string): Promise<boolean> {
    const params = { hash, urls };
    await this.request('/torrents/editTrackers', 'GET', params);
    return true;
  }

  async queueUp(hashes: string | string[] | 'all'): Promise<boolean> {
    const params = {
      hashes: this._normalizeHashes(hashes),
    };
    await this.request('/torrents/increasePrio', 'GET', params);
    return true;
  }

  async queueDown(hashes: string | string[] | 'all'): Promise<boolean> {
    const params = {
      hashes: this._normalizeHashes(hashes),
    };
    await this.request('/torrents/decreasePrio', 'GET', params);
    return true;
  }

  async topPriority(hashes: string | string[] | 'all'): Promise<boolean> {
    const params = {
      hashes: this._normalizeHashes(hashes),
    };
    await this.request('/torrents/topPrio', 'GET', params);
    return true;
  }

  async bottomPriority(hashes: string | string[] | 'all'): Promise<boolean> {
    const params = {
      hashes: this._normalizeHashes(hashes),
    };
    await this.request('/torrents/bottomPrio', 'GET', params);
    return true;
  }

  async login(): Promise<boolean> {
    const url = urljoin(this.config.baseUrl, this.config.path, '/auth/login');
    const options: GotFormOptions<null> = {
      form: true,
      body: {
        username: this.config.username,
        password: this.config.password,
      },
      followRedirect: false,
      retry: 0,
    };

    // allow proxy agent
    if (this.config.agent) {
      options.agent = this.config.agent;
    }

    if (this.config.timeout) {
      options.timeout = this.config.timeout;
    }

    const res = await got.post(url, options);
    if (!res.headers['set-cookie'] || !res.headers['set-cookie'].length) {
      throw new Error('Cookie not found. Auth Failed.');
    }

    const cookie = Cookie.parse(res.headers['set-cookie'][0]);
    if (!cookie || cookie.key !== 'SID') {
      throw new Error('Invalid cookie');
    }

    this._sid = cookie.value;
    return true;
  }

  logout() {
    this._sid = undefined;
    return true;
  }

  // eslint-disable-next-line max-params
  async request<T extends object | string>(
    path: string,
    method: string,
    params: any = {},
    body?: any,
    headers: any = {},
    json = true,
  ): Promise<Response<T>> {
    if (!this._sid) {
      const authed = await this.login();
      if (!authed) {
        throw new Error('Auth Failed');
      }
    }

    const url = urljoin(this.config.baseUrl, this.config.path, path);
    const options: GotJSONOptions | GotBodyOptions<null> = {
      method,
      headers: {
        Cookie: `SID=${this._sid}`,
        ...headers,
      },
      retry: 0,
      json,
      body,
      query: params,
    };

    // allow proxy agent
    if (this.config.agent) {
      options.agent = this.config.agent;
    }

    if (this.config.timeout) {
      options.timeout = this.config.timeout;
    }

    return got(url, options as any);
  }

  /**
   * Normalizes hashes
   * @returns hashes as string seperated by `|`
   */
  private _normalizeHashes(hashes: string | string[]): string {
    if (Array.isArray(hashes)) {
      return hashes.join('|');
    }

    return hashes;
  }

  private _normalizeTorrentData(torrent: Torrent): NormalizedTorrent {
    let state = TorrentState.unknown;
    if (torrent.state === qbtState.Uploading || qbtState.CheckingUP) {
      state = TorrentState.seeding;
    } else if (torrent.state === qbtState.Downloading) {
      state = TorrentState.downloading;
    } else if (torrent.state === qbtState.CheckingDL) {
      state = TorrentState.checking;
    } else if (torrent.state === qbtState.Error || torrent.state === qbtState.StalledDL) {
      state = TorrentState.error;
    } else if ([qbtState.QueuedDL, qbtState.QueuedUP].includes(torrent.state)) {
      state = TorrentState.queued;
    } else if (torrent.state === qbtState.PausedDL || torrent.state === qbtState.PausedUP) {
      state = TorrentState.paused;
    }

    const isCompleted = torrent.progress >= 100;

    const result: NormalizedTorrent = {
      id: torrent.hash,
      name: torrent.name,
      stateMessage: '',
      state,
      dateAdded: new Date(torrent.added_on * 1000).toISOString(),
      isCompleted,
      progress: torrent.progress,
      label: torrent.category,
      dateCompleted: new Date(torrent.completion_on * 1000).toISOString(),
      savePath: torrent.save_path,
      uploadSpeed: torrent.upspeed,
      downloadSpeed: torrent.dlspeed,
      eta: torrent.eta,
      queuePosition: torrent.priority,
      connectedPeers: torrent.num_leechs,
      connectedSeeds: torrent.num_seeds,
      totalPeers: torrent.num_incomplete,
      totalSeeds: torrent.num_complete,
      totalSelected: torrent.size,
      totalSize: torrent.total_size,
      totalUploaded: torrent.uploaded,
      totalDownloaded: torrent.downloaded,
      ratio: torrent.ratio,
    };
    return result;
  }
}
