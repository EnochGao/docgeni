import { SyncHook, AsyncSeriesHook } from 'tapable';
import { Plugin } from './plugins';
import { DocgeniConfig, DocgeniSiteConfig, NavigationItem, ChannelItem } from './interfaces';
import * as path from 'path';
import { toolkit } from '@docgeni/toolkit';

import { DocgeniContext, DocgeniHooks, DocSourceFile, DocgeniOptions, LibraryContext, LibraryComponentContext } from './docgeni.interface';
import { DEFAULT_CONFIG } from './defaults';
import { Detector } from './detector';
import { SiteBuilder } from './site-builder';
import { DocgeniPaths } from './docgeni-paths';
import { ValidationError } from './errors';
import * as semver from 'semver';
import { DocsBuilder, LibrariesBuilder, NavsBuilder } from './builders';

export class Docgeni implements DocgeniContext {
    watch: boolean;
    paths: DocgeniPaths;
    config: DocgeniConfig;
    siteConfig: Partial<DocgeniSiteConfig> = {};
    enableIvy: boolean;
    public docsBuilder: DocsBuilder;
    public librariesBuilders: LibrariesBuilder;
    public navsBuilder: NavsBuilder;
    private options: DocgeniOptions;
    private presets: string[];
    private plugins: string[];
    private initialPlugins: Plugin[] = [];
    private siteBuilder: SiteBuilder;

    hooks: DocgeniHooks = {
        run: new SyncHook([]),
        docCompile: new SyncHook<DocSourceFile>(['docSourceFile']),
        docsCompile: new SyncHook<DocSourceFile[]>(['docSourceFiles']),
        libCompile: new SyncHook<LibraryContext>(['lib']),
        libComponentCompile: new SyncHook<LibraryContext, LibraryComponentContext>(['lib', 'component']),
        emit: new AsyncSeriesHook<void>([])
    };

    get logger() {
        return toolkit.print;
    }

    constructor(options: DocgeniOptions) {
        this.options = options;
        this.config = { ...DEFAULT_CONFIG, ...options.config };
        this.siteConfig = {
            title: this.config.title,
            heading: this.config.heading,
            description: this.config.description,
            mode: this.config.mode,
            theme: this.config.theme,
            baseHref: this.config.baseHref,
            heads: this.config.heads,
            locales: this.config.locales,
            defaultLocale: this.config.defaultLocale,
            logoUrl: this.config.logoUrl,
            repoUrl: this.config.repoUrl
        };
        this.paths = new DocgeniPaths(options.cwd || process.cwd(), this.config.docsPath, this.config.output);
        this.watch = options.watch || false;
        this.presets = options.presets || [];
        this.plugins = options.plugins || [
            require.resolve('./plugins/markdown'),
            require.resolve('./plugins/config'),
            require.resolve('./plugins/angular')
        ];
        if (!this.config.libs) {
            this.config.libs = [];
        }

        this.initialize();
    }

    async run() {
        try {
            await this.verifyConfig();
            const detector = new Detector(this);
            await detector.detect();
            if (this.config.siteProjectName && !detector.siteProject) {
                throw new ValidationError(`site project name(${this.config.siteProjectName}) is not exists`);
            }
            this.enableIvy = detector.ngVersion ? semver.gte(detector.ngVersion, '9.0.0') : true;
            this.siteBuilder = new SiteBuilder(this);
            await this.siteBuilder.initialize(detector.siteProject);
            this.hooks.run.call();

            this.librariesBuilders = new LibrariesBuilder(this);
            this.docsBuilder = new DocsBuilder(this);
            this.navsBuilder = new NavsBuilder(this);

            // clear docs content dist dir
            await toolkit.fs.remove(this.paths.absSiteContentPath);
            // clear assets content dist dir
            await toolkit.fs.remove(this.paths.absSiteAssetsContentPath);

            // ensure docs content dist dir and assets content dist dir
            toolkit.fs.ensureDir(this.paths.absSiteContentPath);
            toolkit.fs.ensureDir(this.paths.absSiteAssetsContentPath);

            this.docsBuilder.hooks.buildDocsSucceed.tap('EmitDocs', async docsBuilder => {
                await docsBuilder.emit();
            });
            await this.docsBuilder.build();

            this.librariesBuilders.hooks.buildLibrariesSucceed.tap('EmitLibs', async librariesBuilders => {
                await librariesBuilders.emit();
            });
            await this.librariesBuilders.build();
            await this.navsBuilder.run();

            this.docsBuilder.watch();
            this.librariesBuilders.watch();

            await this.generateSiteConfig();

            if (!this.options.cmdArgs.skipSite) {
                if (this.watch) {
                    await this.siteBuilder.start();
                } else {
                    await this.siteBuilder.build(this.options.cmdArgs);
                }
            }
        } catch (error) {
            if (error instanceof ValidationError) {
                this.logger.error(error.message);
            } else {
                this.logger.error(error);
            }
            process.exit(0);
        }
    }

    private initialize() {
        this.loadPresets();
        this.loadPlugins();
        this.initialPlugins.forEach(plugin => {
            plugin.apply(this);
        });
        toolkit.initialize({
            baseDir: __dirname
        });
    }

    private async verifyConfig() {
        if (this.config.docsPath && !toolkit.fs.existsSync(this.config.docsPath)) {
            throw new ValidationError(`docs folder(${this.config.docsPath}) has not exists`);
        }
    }

    private async generateSiteConfig() {
        const outputConfigPath = path.resolve(this.paths.absSiteContentPath, 'config.ts');
        toolkit.template.generate('config.hbs', outputConfigPath, {
            siteConfig: JSON.stringify(this.siteConfig, null, 4)
        });
    }

    public getAbsPath(absOrRelativePath: string) {
        return path.resolve(this.paths.cwd, absOrRelativePath);
    }

    private loadPresets() {
        this.presets.forEach(preset => {
            const result = require(preset);
            result(this);
        });
    }

    private loadPlugins() {
        this.plugins.map(name => {
            const pluginCtor = require(name);
            if (pluginCtor) {
                this.initialPlugins.push(new pluginCtor());
            } else {
                throw new Error(`plugin ${name} is not found`);
            }
        });
    }
}
