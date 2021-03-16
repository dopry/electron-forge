/* eslint "no-console": "off" */
import { asyncOra } from '@electron-forge/async-ora';
import debug from 'debug';
import { ElectronProcess, ForgeConfig } from '@electron-forge/shared-types';
import express from 'express';
import fs from 'fs-extra';
import http from 'http';
import Logger, { Tab } from '@electron-forge/web-multi-logger';
import path from 'path';
import PluginBase from '@electron-forge/plugin-base';
import webpack, {
  Configuration, Stats, Watching,
} from 'webpack';
import webpackDevMiddleware from 'webpack-dev-middleware';
import webpackHotMiddleware from 'webpack-hot-middleware';

import once from './util/once';
import { WebpackPluginConfig } from './Config';
import WebpackConfigGenerator from './WebpackConfig';

const d = debug('electron-forge:plugin:webpack');
const DEFAULT_PORT = 3000;
const DEFAULT_LOGGER_PORT = 9000;

export default class WebpackPlugin extends PluginBase<WebpackPluginConfig> {
  name = 'webpack';

  private isProd = false;

  private projectDir!: string;

  private baseDir!: string;

  private _configGenerator!: WebpackConfigGenerator;

  private watchers: Watching[] = [];

  private servers: http.Server[] = [];

  private loggers: Logger[] = [];

  private port = DEFAULT_PORT;

  private loggerPort = DEFAULT_LOGGER_PORT;

  constructor(config: WebpackPluginConfig) {
    super(config);

    if (config.port) {
      if (this.isValidPort(config.port)) {
        this.port = config.port;
      }
    }
    if (config.loggerPort) {
      if (this.isValidPort(config.loggerPort)) {
        this.loggerPort = config.loggerPort;
      }
    }

    this.startLogic = this.startLogic.bind(this);
    this.getHook = this.getHook.bind(this);
  }

  private isValidPort(port: number) {
    if (port < 1024) {
      throw new Error(`Cannot specify port (${port}) below 1024, as they are privileged`);
    } else if (port > 65535) {
      throw new Error(`Port specified (${port}) is not a valid TCP port.`);
    } else {
      return true;
    }
  }

  private exitHandler(options: { cleanup?: boolean; exit?: boolean }, err?: Error) {
    d('handling process exit with:', options);
    if (options.cleanup) {
      for (const watcher of this.watchers) {
        d('cleaning webpack watcher');
        watcher.close(() => {});
      }
      this.watchers = [];
      for (const server of this.servers) {
        d('cleaning http server');
        server.close();
      }
      this.servers = [];
      for (const logger of this.loggers) {
        d('stopping logger');
        logger.stop();
      }
      this.loggers = [];
    }
    if (err) console.error(err.stack);
    if (options.exit) process.exit();
  }

  async writeJSONStats(
    type: string,
    stats: Stats,
    statsOptions?: any, // TODO: change that
  ): Promise<void> {
    d(`Writing JSON stats for ${type} config`);
    const jsonStats = stats.toJson(statsOptions);
    const jsonStatsFilename = path.resolve(this.baseDir, type, 'stats.json');
    await fs.writeJson(jsonStatsFilename, jsonStats, { spaces: 2 });
  }

  private async runWebpack(options: Configuration): Promise<Stats> {
    const compiler = webpack(options);
    return new Promise((resolve, reject) => {
      compiler.run(async (err, stats) => {
        if (err) {
          return reject(err);
        }
        if (stats === undefined) {
          return reject(new Error("No Webpack Stats, this shouldn't happen"));
        }
        return resolve(stats);
      });
    });
  }

  init(dir: string) {
    this.setDirectories(dir);

    d('hooking process events');
    process.on('exit', (_code) => this.exitHandler({ cleanup: true }));
    process.on('SIGINT' as NodeJS.Signals, (_signal) => this.exitHandler({ exit: true }));
  }

  setDirectories(dir: string) {
    this.projectDir = dir;
    this.baseDir = path.resolve(dir, '.webpack');
  }

  get configGenerator() {
    // eslint-disable-next-line no-underscore-dangle
    if (!this._configGenerator) {
    // eslint-disable-next-line no-underscore-dangle
      this._configGenerator = new WebpackConfigGenerator(
        this.config,
        this.projectDir,
        this.isProd,
        this.port,
      );
    }

    // eslint-disable-next-line no-underscore-dangle
    return this._configGenerator;
  }

  private loggedOutputUrl = false;

  getHook(name: string) {
    switch (name) {
      case 'prePackage':
        this.isProd = true;
        return async () => {
          await fs.remove(this.baseDir);
          await this.compileMain();
          await this.compileRenderers();
        };
      case 'postStart':
        return async (_: any, child: ElectronProcess) => {
          if (!this.loggedOutputUrl) {
            console.info(`\n\nWebpack Output Available: ${(`http://localhost:${this.loggerPort}`).cyan}\n`);
            this.loggedOutputUrl = true;
          }
          d('hooking electron process exit');
          child.on('exit', () => {
            if (child.restarted) return;
            this.exitHandler({ cleanup: true, exit: true });
          });
        };
      case 'resolveForgeConfig':
        return async (forgeConfig: ForgeConfig) => this.resolveForgeConfig(forgeConfig);
      case 'packageAfterCopy':
        return async (_: any, buildPath: string) => this.packageAfterCopy(_, buildPath);
      default:
        return null;
    }
  }

  async resolveForgeConfig(forgeConfig: ForgeConfig) {
    if (!forgeConfig.packagerConfig) {
      forgeConfig.packagerConfig = {};
    }
    if (forgeConfig.packagerConfig.ignore) {
      console.error(`You have set packagerConfig.ignore, the Electron Forge webpack plugin normally sets this automatically.

Your packaged app may be larger than expected if you dont ignore everything other than the '.webpack' folder`.red);
      return forgeConfig;
    }
    forgeConfig.packagerConfig.ignore = (file: string) => {
      if (!file) return false;

      if (this.config.jsonStats && file.endsWith(path.join('.webpack', 'main', 'stats.json'))) {
        return true;
      }

      if (this.config.renderer.jsonStats && file.endsWith(path.join('.webpack', 'renderer', 'stats.json'))) {
        return true;
      }

      return !/^[/\\]\.webpack($|[/\\]).*$/.test(file);
    };
    return forgeConfig;
  }

  async packageAfterCopy(_: any, buildPath: string) {
    const pj = await fs.readJson(path.resolve(this.projectDir, 'package.json'));
    if (pj.config) {
      delete pj.config.forge;
    }
    pj.devDependencies = {};
    pj.dependencies = {};
    pj.optionalDependencies = {};
    pj.peerDependencies = {};

    await fs.writeJson(
      path.resolve(buildPath, 'package.json'),
      pj,
      {
        spaces: 2,
      },
    );

    await fs.mkdirp(path.resolve(buildPath, 'node_modules'));
  }

  async compileMain(watch = false, logger?: Logger) {
    let tab: Tab;
    if (logger) {
      tab = logger.createTab('Main Process');
    }

    await asyncOra('Compiling Main Process Code', async () => {
      const mainConfig = await this.configGenerator.getMainConfig();
      await new Promise<void>((resolve, reject) => {
        const compiler = webpack(mainConfig);
        const [onceResolve, onceReject] = once(resolve, reject);
        const cb = async (err: any, stats: Stats | undefined) => {
          if (err) {
            return onceReject(err);
          }

          if (stats === undefined) {
            return onceReject(new Error("No Webpack Stats, this shouldn't happen"));
          }

          if (tab) {
            tab.log(stats.toString({
              colors: true,
            }));
          }
          if (this.config.jsonStats) {
            await this.writeJSONStats('main', stats, mainConfig.stats);
          }

          if (!watch && stats.hasErrors()) {
            return onceReject(new Error(`Compilation errors in the main process: ${stats.toString()}`));
          }

          return onceResolve();
        };

        if (watch) {
          this.watchers.push(compiler.watch({}, cb));
        } else {
          compiler.run(cb);
        }
      });
    });
  }

  async compileRenderers(watch = false) {
    await asyncOra('Compiling Renderer Template', async () => {
      const options = await this.configGenerator
        .getRendererConfig(this.config.renderer.entryPoints);
      const stats = await this.runWebpack(options);
      if (this.config.renderer.jsonStats) {
        await this.writeJSONStats('renderer', stats, options.stats);
      }
      if (!watch && stats.hasErrors()) {
        throw new Error(`Compilation errors in the renderer: ${stats.toString()}`);
      }
    });

    for (const entryPoint of this.config.renderer.entryPoints) {
      if (entryPoint.preload) {
        await asyncOra(`Compiling Renderer Preload: ${entryPoint.name}`, async () => {
          const options = await this.configGenerator
            .getPreloadRendererConfig(entryPoint, entryPoint.preload!);
          await this.runWebpack(options);
        });
      }
    }
  }

  launchDevServers = async (logger: Logger) => {
    await asyncOra('Launch Dev Servers', async () => {
      const tab = logger.createTab('Renderers');

      const config = await this.configGenerator.getRendererConfig(this.config.renderer.entryPoints);
      const compiler = webpack(config);
      const app = express();
      const server = webpackDevMiddleware(compiler, {
        publicPath: '/',
        writeToDisk: true,
      });

      const wpLogger = compiler.getInfrastructureLogger('webpack-dev-server');
      wpLogger.debug = tab.log.bind(tab);
      wpLogger.log = tab.log.bind(tab);
      wpLogger.info = tab.log.bind(tab);
      wpLogger.error = tab.log.bind(tab);
      wpLogger.warn = tab.log.bind(tab);
      app.use(server);
      app.use(webpackHotMiddleware(compiler));
      this.servers.push(app.listen(this.port));
    });

    await asyncOra('Compiling Preload Scripts', async () => {
      for (const entryPoint of this.config.renderer.entryPoints) {
        if (entryPoint.preload) {
          const config = await this.configGenerator.getPreloadRendererConfig(
            entryPoint,
            entryPoint.preload!,
          );
          await new Promise<void>((resolve, reject) => {
            const tab = logger.createTab(`${entryPoint.name} - Preload`);
            const [onceResolve, onceReject] = once(resolve, reject);

            this.watchers.push(webpack(config).watch({}, (err, stats) => {
              if (stats) {
                tab.log(stats.toString({
                  colors: true,
                }));
              }
              if (err) return onceReject(err);
              return onceResolve();
            }));
          });
        }
      }
    });
  }

  private alreadyStarted = false;

  async startLogic(): Promise<false> {
    if (this.alreadyStarted) return false;
    this.alreadyStarted = true;

    await fs.remove(this.baseDir);

    const logger = new Logger(this.loggerPort);
    this.loggers.push(logger);
    await this.compileMain(true, logger);
    await this.launchDevServers(logger);
    await logger.start();
    return false;
  }
}
