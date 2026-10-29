import { z } from 'zod';

export const MAX_PINS = 36;
export const DOCK_SIZE_MIN = 3;
export const DOCK_SIZE_MAX = 7;
export const PAGE_ROWS_MIN = 1;
export const PAGE_ROWS_MAX = 3;
export const LOCKED_CATEGORY = { hosted: 'hosted', none: 'none' } as const;

const Id = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/i, 'invalid id');

const HttpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
    } catch {
      return false;
    }
  }, 'expected http(s) url');

export const IconSchema = z.object({
  /** auto: site favicon · library: dashboard-icons slug (`si:` prefix = Simple Icons) · builtin: Nexus-drawn service glyph */
  source: z.enum(['auto', 'library', 'upload', 'letter', 'builtin']),
  ref: z.string().max(256).default(''),
  letter: z.string().max(2).default(''),
  tone: z.number().int().min(0).max(3).default(0),
});

export const HealthSchema = z.object({
  enabled: z.boolean().default(false),
  /** Path appended to the service base url (`/api/health`) or a same-host absolute url. */
  target: z.string().trim().max(512).default('/'),
  intervalSec: z.union([z.literal(30), z.literal(60), z.literal(300)]).default(60),
});

export const AppSchema = z.object({
  id: Id,
  kind: z.enum(['site', 'service']),
  name: z.string().trim().min(1).max(32),
  description: z.string().trim().max(40).default(''),
  url: HttpUrl,
  lanUrl: z.union([HttpUrl, z.literal('')]).default(''),
  prefer: z.enum(['ext', 'lan']).default('ext'),
  categoryId: Id,
  hidden: z.boolean().default(false),
  /** Services only: shown in the Dock / mobile home service area. */
  showInServices: z.boolean().default(true),
  aliases: z.array(z.string().trim().max(32)).max(12).default([]),
  icon: IconSchema,
  openIn: z.enum(['same', 'new']).default('same'),
  health: HealthSchema.default({ enabled: false, target: '/', intervalSec: 60 }),
});

export const CategorySchema = z.object({
  id: Id,
  label: z.string().trim().min(1).max(16),
  locked: z.boolean().default(false),
});

export const EngineSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(24),
  /** `%s` is replaced by the encoded query. Empty for the Linkwarden engine (served by Nexus). */
  urlTemplate: z.string().trim().max(512),
  prefix: z.string().trim().max(8).default(''),
  builtin: z.boolean().default(false),
  kind: z.enum(['web', 'linkwarden']).default('web'),
  icon: z.string().max(256).default(''),
});

const Focal = z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]);
const WallId = z.string().min(1).max(64);

export const GALLERY_CATEGORY_IDS = ['nature', 'architecture', 'minimal', 'city', 'dark'] as const;

/**
 * 背景切换 (v0.2). `off` keeps `look.wallpaper`; the timed modes pick from the pool by time, so every
 * device shows the same picture without writing anything; `potd` is Wikimedia's picture of the day.
 */
export const RotationSchema = z
  .object({
    mode: z.enum(['off', 'open', 'hourly', 'daily', 'interval', 'potd']).default('off'),
    minutes: z.number().int().min(5).max(720).default(30),
    /** library: my wallpapers; favorites: starred ones; gallery: 精选图库 categories. */
    pool: z.enum(['library', 'favorites', 'gallery']).default('library'),
    categories: z.array(z.enum(GALLERY_CATEGORY_IDS)).max(5).default([...GALLERY_CATEGORY_IDS]),
  })
  .prefault({});

/** 显示方式: always, only on hover / focus (and when it has something urgent to say), or never. */
const Show = z.enum(['show', 'hover', 'hide']);
const OnOff = z.enum(['show', 'hide']);

/**
 * 首页显示与布局 (v0.2). Desktop and phone are separate so that one device's layout never rewrites
 * the other's. Presets only change these fields, never apps or pins.
 */
export const UiSchema = z
  .object({
    preset: z.enum(['daily', 'minimal', 'custom']).default('daily'),
    desktop: z
      .object({
        /** The whole top-left area: logo and navigation. */
        topbar: Show.default('show'),
        brand: z.boolean().default(true),
        navHome: z.boolean().default(true),
        navApps: z.boolean().default(true),
        navOverview: z.boolean().default(true),
        /** Service status; an unseen 异常 shows regardless. */
        status: Show.default('show'),
        settings: Show.default('show'),
        clock: OnOff.default('show'),
        /** Hidden search returns on `/`, Ctrl+K or a click on the empty slab. */
        search: OnOff.default('show'),
        shortcuts: OnOff.default('show'),
        /** Labels under the icons only while the pointer is on them. */
        labelsOnHover: z.boolean().default(false),
        wallpaperName: Show.default('show'),
        /** Credits a license requires stay visible whatever this says. */
        wallpaperCredit: Show.default('show'),
        /** 换一张 (the other actions appear when the pointer is on the bar). */
        wallpaperActions: Show.default('show'),
        searchWidth: z.number().int().min(640).max(960).default(760),
        /** Vertical position, % of the viewport height relative to the default. */
        offsetY: z.number().int().min(-12).max(12).default(0),
        clockScale: z.number().min(0.7).max(1.4).default(1),
      })
      .prefault({}),
    mobile: z
      .object({
        status: OnOff.default('show'),
        /** Hidden settings button: long-press the wallpaper or use the search action instead. */
        settings: OnOff.default('show'),
        clock: OnOff.default('show'),
        wallpaperCredit: OnOff.default('show'),
        clockScale: z.number().min(0.7).max(1.4).default(1),
      })
      .prefault({}),
  })
  .prefault({});

export const SettingsSchema = z.object({
  search: z.object({
    defaultEngine: Id,
    suggest: z.boolean(),
    history: z.boolean(),
    historyDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    showApps: z.boolean(),
    linkwarden: z.boolean(),
  }),
  home: z.object({
    dockSize: z.number().int().min(DOCK_SIZE_MIN).max(DOCK_SIZE_MAX),
    mobileRows: z.union([z.literal(2), z.literal(3)]),
    showServices: z.boolean(),
    labels: z.object({ desktop: z.boolean(), mobile: z.boolean() }),
    showRecent: z.boolean(),
    /**
     * Pinned sites beyond the first row (v0.2). `single`: first row only (the rest live in the
     * drawer and on mobile); `expand`: a collapsed extension area; `double`: always expanded.
     * Defaults keep documents written by v0.1 valid.
     */
    shortcuts: z
      .object({
        mode: z.enum(['single', 'expand', 'double']).default('expand'),
        /** Desktop extension rows per page. */
        pageRows: z.number().int().min(PAGE_ROWS_MIN).max(PAGE_ROWS_MAX).default(2),
        pager: z.boolean().default(true),
        /** Each browser remembers whether it left the extension open. */
        remember: z.boolean().default(false),
      })
      .prefault({}),
  }),
  look: z.object({
    wallpaper: z.string().min(1).max(64),
    tone: z.enum(['warm', 'original']),
    overlay: z.number().min(0).max(80),
    brightness: z.number().min(60).max(120),
    blur: z.number().min(0).max(24),
    theme: z.enum(['dark', 'light', 'auto']),
    clock: z.enum(['24', '12']),
    showDate: z.boolean(),
    showSeconds: z.boolean(),
    iconSize: z.enum(['s', 'm', 'l']),
    motion: z.enum(['full', 'reduced', 'off']),
    focal: z.object({ desktop: Focal, mobile: Focal }),
    rotation: RotationSchema,
    /** Starred wallpapers (ids). */
    favorites: z.array(WallId).max(200).default([]),
    /** 不喜欢: never picked by rotation. */
    blocked: z.array(WallId).max(500).default([]),
  }),
  privacy: z.object({
    guest: z.boolean(),
    recordRecent: z.boolean(),
    cacheIcons: z.boolean(),
  }),
  ui: UiSchema,
});

export const ConfigSchema = z.object({
  /** Array order is the manual order inside each category (drawer, settings); it is never re-sorted. */
  apps: z.array(AppSchema).max(500),
  /** Array order is the order of the category groups. */
  categories: z.array(CategorySchema).max(50),
  /**
   * Ordered ids of pinned sites. The Dock shows the first `dockSize`, mobile the first
   * `rows × 4 − services`; the rest fill the extension pages. Independent of `apps` order.
   */
  pins: z.array(Id).max(MAX_PINS),
  engines: z.array(EngineSchema).max(30),
  settings: SettingsSchema,
});

export type Icon = z.infer<typeof IconSchema>;
export type Health = z.infer<typeof HealthSchema>;
export type AppEntry = z.infer<typeof AppSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Engine = z.infer<typeof EngineSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type UiSettings = z.infer<typeof UiSchema>;
export type SettingsSection = keyof Settings;
export type Config = z.infer<typeof ConfigSchema>;

export interface Snapshot {
  revision: number;
  updatedAt: string;
  config: Config;
}
