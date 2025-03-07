import {extend, bindAll, warnOnce, uniqueId, isImageBitmap} from '../util/util';
import browser from '../util/browser';
import DOM from '../util/dom';
import packageJSON from '../../package.json' assert {type: 'json'};
import {getImage, GetImageCallback, getJSON, ResourceType} from '../util/ajax';
import {RequestManager} from '../util/request_manager';
import Style from '../style/style';
import EvaluationParameters from '../style/evaluation_parameters';
import Painter from '../render/painter';
import Transform from '../geo/transform';
import Hash from './hash';
import HandlerManager from './handler_manager';
import Camera from './camera';
import LngLat from '../geo/lng_lat';
import LngLatBounds from '../geo/lng_lat_bounds';
import Point from '@mapbox/point-geometry';
import AttributionControl from './control/attribution_control';
import LogoControl from './control/logo_control';
import {supported} from '@mapbox/mapbox-gl-supported';
import {RGBAImage} from '../util/image';
import {Event, ErrorEvent, Listener} from '../util/evented';
import {MapEventType, MapLayerEventType, MapMouseEvent} from './events';
import TaskQueue from '../util/task_queue';
import webpSupported from '../util/webp_supported';
import {PerformanceMarkers, PerformanceUtils} from '../util/performance';
import {setCacheLimits} from '../util/tile_request_cache';
import {Source} from '../source/source';
import StyleLayer from '../style/style_layer';

import type {RequestTransformFunction} from '../util/request_manager';
import type {LngLatLike} from '../geo/lng_lat';
import type {LngLatBoundsLike} from '../geo/lng_lat_bounds';
import type {FeatureIdentifier, StyleOptions, StyleSetterOptions} from '../style/style';
import type {MapEvent, MapDataEvent} from './events';
import type {CustomLayerInterface} from '../style/style_layer/custom_style_layer';
import type {StyleImageInterface, StyleImageMetadata} from '../style/style_image';
import type {PointLike} from './camera';
import type ScrollZoomHandler from './handler/scroll_zoom';
import type BoxZoomHandler from './handler/box_zoom';
import type {TouchPitchHandler} from './handler/touch_zoom_rotate';
import type DragRotateHandler from './handler/shim/drag_rotate';
import DragPanHandler, {DragPanOptions} from './handler/shim/drag_pan';

import type KeyboardHandler from './handler/keyboard';
import type DoubleClickZoomHandler from './handler/shim/dblclick_zoom';
import type TouchZoomRotateHandler from './handler/shim/touch_zoom_rotate';
import defaultLocale from './default_locale';
import type {TaskID} from '../util/task_queue';
import type {Cancelable} from '../types/cancelable';
import type {
    LayerSpecification,
    FilterSpecification,
    StyleSpecification,
    LightSpecification,
    SourceSpecification,
    TerrainSpecification
} from '../style-spec/types.g';
import {Callback} from '../types/callback';
import type {ControlPosition, IControl} from './control/control';
import type {MapGeoJSONFeature} from '../util/vectortile_to_geojson';

const version = packageJSON.version;

/* eslint-enable no-use-before-define */
export type MapOptions = {
    hash?: boolean | string;
    interactive?: boolean;
    container: HTMLElement | string;
    bearingSnap?: number;
    attributionControl?: boolean;
    customAttribution?: string | Array<string>;
    maplibreLogo?: boolean;
    logoPosition?: ControlPosition;
    failIfMajorPerformanceCaveat?: boolean;
    preserveDrawingBuffer?: boolean;
    antialias?: boolean;
    refreshExpiredTiles?: boolean;
    maxBounds?: LngLatBoundsLike;
    scrollZoom?: boolean;
    minZoom?: number | null;
    maxZoom?: number | null;
    minPitch?: number | null;
    maxPitch?: number | null;
    boxZoom?: boolean;
    dragRotate?: boolean;
    dragPan?: DragPanOptions | boolean;
    keyboard?: boolean;
    doubleClickZoom?: boolean;
    touchZoomRotate?: boolean;
    touchPitch?: boolean;
    cooperativeGestures?: boolean | GestureOptions;
    trackResize?: boolean;
    center?: LngLatLike;
    zoom?: number;
    bearing?: number;
    pitch?: number;
    renderWorldCopies?: boolean;
    maxTileCacheSize?: number;
    transformRequest?: RequestTransformFunction;
    locale?: any;
    fadeDuration?: number;
    crossSourceCollisions?: boolean;
    collectResourceTiming?: boolean;
    clickTolerance?: number;
    bounds?: LngLatBoundsLike;
    fitBoundsOptions?: Object;
    localIdeographFontFamily?: string;
    style: StyleSpecification | string;
    pitchWithRotate?: boolean;
    pixelRatio?: number;
};

export type GestureOptions = {
    windowsHelpText?: string;
    macHelpText?: string;
    mobileHelpText?: string;
};

// See article here: https://medium.com/terria/typescript-transforming-optional-properties-to-required-properties-that-may-be-undefined-7482cb4e1585
type Complete<T> = {
    [P in keyof Required<T>]: Pick<T, P> extends Required<Pick<T, P>> ? T[P] : (T[P] | undefined);
}

// This type is used inside map since all properties are assigned a default value.
export type CompleteMapOptions = Complete<MapOptions>;

const defaultMinZoom = -2;
const defaultMaxZoom = 22;

// the default values, but also the valid range
const defaultMinPitch = 0;
const defaultMaxPitch = 60;

// use this variable to check maxPitch for validity
const maxPitchThreshold = 85;

const defaultOptions = {
    center: [0, 0],
    zoom: 0,
    bearing: 0,
    pitch: 0,

    minZoom: defaultMinZoom,
    maxZoom: defaultMaxZoom,

    minPitch: defaultMinPitch,
    maxPitch: defaultMaxPitch,

    interactive: true,
    scrollZoom: true,
    boxZoom: true,
    dragRotate: true,
    dragPan: true,
    keyboard: true,
    doubleClickZoom: true,
    touchZoomRotate: true,
    touchPitch: true,
    cooperativeGestures: undefined,

    bearingSnap: 7,
    clickTolerance: 3,
    pitchWithRotate: true,

    hash: false,
    attributionControl: true,
    maplibreLogo: false,

    failIfMajorPerformanceCaveat: false,
    preserveDrawingBuffer: false,
    trackResize: true,
    renderWorldCopies: true,
    refreshExpiredTiles: true,
    maxTileCacheSize: null,
    localIdeographFontFamily: 'sans-serif',
    transformRequest: null,
    fadeDuration: 300,
    crossSourceCollisions: true
} as CompleteMapOptions;

/**
 * The `Map` object represents the map on your page. It exposes methods
 * and properties that enable you to programmatically change the map,
 * and fires events as users interact with it.
 *
 * You create a `Map` by specifying a `container` and other options.
 * Then MapLibre GL JS initializes the map on the page and returns your `Map`
 * object.
 *
 * @extends Evented
 * @param {Object} options
 * @param {HTMLElement|string} options.container The HTML element in which MapLibre GL JS will render the map, or the element's string `id`. The specified element must have no children.
 * @param {number} [options.minZoom=0] The minimum zoom level of the map (0-24).
 * @param {number} [options.maxZoom=22] The maximum zoom level of the map (0-24).
 * @param {number} [options.minPitch=0] The minimum pitch of the map (0-85). Values greater than 60 degrees are experimental and may result in rendering issues. If you encounter any, please raise an issue with details in the MapLibre project.
 * @param {number} [options.maxPitch=60] The maximum pitch of the map (0-85). Values greater than 60 degrees are experimental and may result in rendering issues. If you encounter any, please raise an issue with details in the MapLibre project.
 * @param {Object|string} [options.style] The map's MapLibre style. This must be an a JSON object conforming to
 * the schema described in the [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/), or a URL to
 * such JSON.
 *
 *
 * @param {(boolean|string)} [options.hash=false] If `true`, the map's position (zoom, center latitude, center longitude, bearing, and pitch) will be synced with the hash fragment of the page's URL.
 *   For example, `http://path/to/my/page.html#2.59/39.26/53.07/-24.1/60`.
 *   An additional string may optionally be provided to indicate a parameter-styled hash,
 *   e.g. http://path/to/my/page.html#map=2.59/39.26/53.07/-24.1/60&foo=bar, where foo
 *   is a custom parameter and bar is an arbitrary hash distinct from the map hash.
 * @param {boolean} [options.interactive=true] If `false`, no mouse, touch, or keyboard listeners will be attached to the map, so it will not respond to interaction.
 * @param {number} [options.bearingSnap=7] The threshold, measured in degrees, that determines when the map's
 *   bearing will snap to north. For example, with a `bearingSnap` of 7, if the user rotates
 *   the map within 7 degrees of north, the map will automatically snap to exact north.
 * @param {boolean} [options.pitchWithRotate=true] If `false`, the map's pitch (tilt) control with "drag to rotate" interaction will be disabled.
 * @param {number} [options.clickTolerance=3] The max number of pixels a user can shift the mouse pointer during a click for it to be considered a valid click (as opposed to a mouse drag).
 * @param {boolean} [options.attributionControl=true] If `true`, an {@link AttributionControl} will be added to the map.
 * @param {string | Array<string>} [options.customAttribution] String or strings to show in an {@link AttributionControl}. Only applicable if `options.attributionControl` is `true`.
 * @param {boolean} [options.maplibreLogo=false] If `true`, the MapLibre logo will be shown.
 * @param {string} [options.logoPosition='bottom-left'] A string representing the position of the MapLibre wordmark on the map. Valid options are `top-left`,`top-right`, `bottom-left`, `bottom-right`.
 * @param {boolean} [options.failIfMajorPerformanceCaveat=false] If `true`, map creation will fail if the performance of MapLibre
 *   GL JS would be dramatically worse than expected (i.e. a software renderer would be used).
 * @param {boolean} [options.preserveDrawingBuffer=false] If `true`, the map's canvas can be exported to a PNG using `map.getCanvas().toDataURL()`. This is `false` by default as a performance optimization.
 * @param {boolean} [options.antialias] If `true`, the gl context will be created with MSAA antialiasing, which can be useful for antialiasing custom layers. this is `false` by default as a performance optimization.
 * @param {boolean} [options.refreshExpiredTiles=true] If `false`, the map won't attempt to re-request tiles once they expire per their HTTP `cacheControl`/`expires` headers.
 * @param {LngLatBoundsLike} [options.maxBounds] If set, the map will be constrained to the given bounds.
 * @param {boolean|Object} [options.scrollZoom=true] If `true`, the "scroll to zoom" interaction is enabled. An `Object` value is passed as options to {@link ScrollZoomHandler#enable}.
 * @param {boolean} [options.boxZoom=true] If `true`, the "box zoom" interaction is enabled (see {@link BoxZoomHandler}).
 * @param {boolean} [options.dragRotate=true] If `true`, the "drag to rotate" interaction is enabled (see {@link DragRotateHandler}).
 * @param {boolean|Object} [options.dragPan=true] If `true`, the "drag to pan" interaction is enabled. An `Object` value is passed as options to {@link DragPanHandler#enable}.
 * @param {boolean} [options.keyboard=true] If `true`, keyboard shortcuts are enabled (see {@link KeyboardHandler}).
 * @param {boolean} [options.doubleClickZoom=true] If `true`, the "double click to zoom" interaction is enabled (see {@link DoubleClickZoomHandler}).
 * @param {boolean|Object} [options.touchZoomRotate=true] If `true`, the "pinch to rotate and zoom" interaction is enabled. An `Object` value is passed as options to {@link TouchZoomRotateHandler#enable}.
 * @param {boolean|Object} [options.touchPitch=true] If `true`, the "drag to pitch" interaction is enabled. An `Object` value is passed as options to {@link TouchPitchHandler#enable}.
 * @param {boolean|GestureOptions} [options.cooperativeGestures=undefined] If `true` or set to an options object, map is only accessible on desktop while holding Command/Ctrl and only accessible on mobile with two fingers. Interacting with the map using normal gestures will trigger an informational screen. With this option enabled, "drag to pitch" requires a three-finger gesture.
 * A valid options object includes the following properties to customize the text on the informational screen. The values below are the defaults.
 * {
 *   windowsHelpText: "Use Ctrl + scroll to zoom the map",
 *   macHelpText: "Use ⌘ + scroll to zoom the map",
 *   mobileHelpText: "Use two fingers to move the map",
 * }
 * @param {boolean} [options.trackResize=true] If `true`, the map will automatically resize when the browser window resizes.
 * @param {LngLatLike} [options.center=[0, 0]] The initial geographical centerpoint of the map. If `center` is not specified in the constructor options, MapLibre GL JS will look for it in the map's style object. If it is not specified in the style, either, it will default to `[0, 0]` Note: MapLibre GL uses longitude, latitude coordinate order (as opposed to latitude, longitude) to match GeoJSON.
 * @param {number} [options.zoom=0] The initial zoom level of the map. If `zoom` is not specified in the constructor options, MapLibre GL JS will look for it in the map's style object. If it is not specified in the style, either, it will default to `0`.
 * @param {number} [options.bearing=0] The initial bearing (rotation) of the map, measured in degrees counter-clockwise from north. If `bearing` is not specified in the constructor options, MapLibre GL JS will look for it in the map's style object. If it is not specified in the style, either, it will default to `0`.
 * @param {number} [options.pitch=0] The initial pitch (tilt) of the map, measured in degrees away from the plane of the screen (0-85). If `pitch` is not specified in the constructor options, MapLibre GL JS will look for it in the map's style object. If it is not specified in the style, either, it will default to `0`. Values greater than 60 degrees are experimental and may result in rendering issues. If you encounter any, please raise an issue with details in the MapLibre project.
 * @param {LngLatBoundsLike} [options.bounds] The initial bounds of the map. If `bounds` is specified, it overrides `center` and `zoom` constructor options.
 * @param {Object} [options.fitBoundsOptions] A {@link Map#fitBounds} options object to use _only_ when fitting the initial `bounds` provided above.
 * @param {boolean} [options.renderWorldCopies=true] If `true`, multiple copies of the world will be rendered side by side beyond -180 and 180 degrees longitude. If set to `false`:
 * - When the map is zoomed out far enough that a single representation of the world does not fill the map's entire
 * container, there will be blank space beyond 180 and -180 degrees longitude.
 * - Features that cross 180 and -180 degrees longitude will be cut in two (with one portion on the right edge of the
 * map and the other on the left edge of the map) at every zoom level.
 * @param {number} [options.maxTileCacheSize=null] The maximum number of tiles stored in the tile cache for a given source. If omitted, the cache will be dynamically sized based on the current viewport.
 * @param {string} [options.localIdeographFontFamily='sans-serif'] Defines a CSS
 *   font-family for locally overriding generation of glyphs in the 'CJK Unified Ideographs', 'Hiragana', 'Katakana' and 'Hangul Syllables' ranges.
 *   In these ranges, font settings from the map's style will be ignored, except for font-weight keywords (light/regular/medium/bold).
 *   Set to `false`, to enable font settings from the map's style for these glyph ranges.
 *   The purpose of this option is to avoid bandwidth-intensive glyph server requests. (See [Use locally generated ideographs](https://maplibre.org/maplibre-gl-js-docs/example/local-ideographs).)
 * @param {RequestTransformFunction} [options.transformRequest=null] A callback run before the Map makes a request for an external URL. The callback can be used to modify the url, set headers, or set the credentials property for cross-origin requests.
 *   Expected to return an object with a `url` property and optionally `headers` and `credentials` properties.
 * @param {boolean} [options.collectResourceTiming=false] If `true`, Resource Timing API information will be collected for requests made by GeoJSON and Vector Tile web workers (this information is normally inaccessible from the main Javascript thread). Information will be returned in a `resourceTiming` property of relevant `data` events.
 * @param {number} [options.fadeDuration=300] Controls the duration of the fade-in/fade-out animation for label collisions, in milliseconds. This setting affects all symbol layers. This setting does not affect the duration of runtime styling transitions or raster tile cross-fading.
 * @param {boolean} [options.crossSourceCollisions=true] If `true`, symbols from multiple sources can collide with each other during collision detection. If `false`, collision detection is run separately for the symbols in each source.
 * @param {Object} [options.locale=null] A patch to apply to the default localization table for UI strings, e.g. control tooltips. The `locale` object maps namespaced UI string IDs to translated strings in the target language; see `src/ui/default_locale.js` for an example with all supported string IDs. The object may specify all UI strings (thereby adding support for a new translation) or only a subset of strings (thereby patching the default translation table).
 * @param {number} [options.pixelRatio] The pixel ratio. The canvas' `width` attribute will be `container.clientWidth * pixelRatio` and its `height` attribute will be `container.clientHeight * pixelRatio`. Defaults to `devicePixelRatio` if not specified.
 * @example
 * var map = new maplibregl.Map({
 *   container: 'map',
 *   center: [-122.420679, 37.772537],
 *   zoom: 13,
 *   style: style_object,
 *   hash: true,
 *   transformRequest: (url, resourceType)=> {
 *     if(resourceType === 'Source' && url.startsWith('http://myHost')) {
 *       return {
 *        url: url.replace('http', 'https'),
 *        headers: { 'my-custom-header': true},
 *        credentials: 'include'  // Include cookies for cross-origin requests
 *      }
 *     }
 *   }
 * });
 * @see [Display a map](https://maplibre.org/maplibre-gl-js-docs/example/simple-map/)
 */
class Map extends Camera {
    style: Style;
    painter: Painter;
    handlers: HandlerManager;

    _container: HTMLElement;
    _canvasContainer: HTMLElement;
    _controlContainer: HTMLElement;
    _controlPositions: {[_: string]: HTMLElement};
    _interactive: boolean;
    _cooperativeGestures: boolean | GestureOptions;
    _cooperativeGesturesScreen: HTMLElement;
    _metaPress: boolean;
    _showTileBoundaries: boolean;
    _showCollisionBoxes: boolean;
    _showPadding: boolean;
    _showOverdrawInspector: boolean;
    _repaint: boolean;
    _vertices: boolean;
    _canvas: HTMLCanvasElement;
    _maxTileCacheSize: number;
    _frame: Cancelable;
    _styleDirty: boolean;
    _sourcesDirty: boolean;
    _placementDirty: boolean;
    _loaded: boolean;
    // accounts for placement finishing as well
    _fullyLoaded: boolean;
    _trackResize: boolean;
    _preserveDrawingBuffer: boolean;
    _failIfMajorPerformanceCaveat: boolean;
    _antialias: boolean;
    _refreshExpiredTiles: boolean;
    _hash: Hash;
    _delegatedListeners: any;
    _fadeDuration: number;
    _crossSourceCollisions: boolean;
    _crossFadingFactor: number;
    _collectResourceTiming: boolean;
    _renderTaskQueue: TaskQueue;
    _controls: Array<IControl>;
    _mapId: number;
    _localIdeographFontFamily: string;
    _requestManager: RequestManager;
    _locale: any;
    _removed: boolean;
    _clickTolerance: number;
    _pixelRatio: number;

    /**
     * The map's {@link ScrollZoomHandler}, which implements zooming in and out with a scroll wheel or trackpad.
     * Find more details and examples using `scrollZoom` in the {@link ScrollZoomHandler} section.
     */
    scrollZoom: ScrollZoomHandler;

    /**
     * The map's {@link BoxZoomHandler}, which implements zooming using a drag gesture with the Shift key pressed.
     * Find more details and examples using `boxZoom` in the {@link BoxZoomHandler} section.
     */
    boxZoom: BoxZoomHandler;

    /**
     * The map's {@link DragRotateHandler}, which implements rotating the map while dragging with the right
     * mouse button or with the Control key pressed. Find more details and examples using `dragRotate`
     * in the {@link DragRotateHandler} section.
     */
    dragRotate: DragRotateHandler;

    /**
     * The map's {@link DragPanHandler}, which implements dragging the map with a mouse or touch gesture.
     * Find more details and examples using `dragPan` in the {@link DragPanHandler} section.
     */
    dragPan: DragPanHandler;

    /**
     * The map's {@link KeyboardHandler}, which allows the user to zoom, rotate, and pan the map using keyboard
     * shortcuts. Find more details and examples using `keyboard` in the {@link KeyboardHandler} section.
     */
    keyboard: KeyboardHandler;

    /**
     * The map's {@link DoubleClickZoomHandler}, which allows the user to zoom by double clicking.
     * Find more details and examples using `doubleClickZoom` in the {@link DoubleClickZoomHandler} section.
     */
    doubleClickZoom: DoubleClickZoomHandler;

    /**
     * The map's {@link TouchZoomRotateHandler}, which allows the user to zoom or rotate the map with touch gestures.
     * Find more details and examples using `touchZoomRotate` in the {@link TouchZoomRotateHandler} section.
     */
    touchZoomRotate: TouchZoomRotateHandler;

    /**
     * The map's {@link TouchPitchHandler}, which allows the user to pitch the map with touch gestures.
     * Find more details and examples using `touchPitch` in the {@link TouchPitchHandler} section.
     */
    touchPitch: TouchPitchHandler;

    constructor(options: MapOptions) {
        PerformanceUtils.mark(PerformanceMarkers.create);

        options = extend({}, defaultOptions, options);

        if (options.minZoom != null && options.maxZoom != null && options.minZoom > options.maxZoom) {
            throw new Error('maxZoom must be greater than or equal to minZoom');
        }

        if (options.minPitch != null && options.maxPitch != null && options.minPitch > options.maxPitch) {
            throw new Error('maxPitch must be greater than or equal to minPitch');
        }

        if (options.minPitch != null && options.minPitch < defaultMinPitch) {
            throw new Error(`minPitch must be greater than or equal to ${defaultMinPitch}`);
        }

        if (options.maxPitch != null && options.maxPitch > maxPitchThreshold) {
            throw new Error(`maxPitch must be less than or equal to ${maxPitchThreshold}`);
        }

        const transform = new Transform(options.minZoom, options.maxZoom, options.minPitch, options.maxPitch, options.renderWorldCopies);
        super(transform, {bearingSnap: options.bearingSnap});

        this._interactive = options.interactive;
        this._cooperativeGestures = options.cooperativeGestures;
        this._maxTileCacheSize = options.maxTileCacheSize;
        this._failIfMajorPerformanceCaveat = options.failIfMajorPerformanceCaveat;
        this._preserveDrawingBuffer = options.preserveDrawingBuffer;
        this._antialias = options.antialias;
        this._trackResize = options.trackResize;
        this._bearingSnap = options.bearingSnap;
        this._refreshExpiredTiles = options.refreshExpiredTiles;
        this._fadeDuration = options.fadeDuration;
        this._crossSourceCollisions = options.crossSourceCollisions;
        this._crossFadingFactor = 1;
        this._collectResourceTiming = options.collectResourceTiming;
        this._renderTaskQueue = new TaskQueue();
        this._controls = [];
        this._mapId = uniqueId();
        this._locale = extend({}, defaultLocale, options.locale);
        this._clickTolerance = options.clickTolerance;
        this._pixelRatio = options.pixelRatio ?? devicePixelRatio;

        this._requestManager = new RequestManager(options.transformRequest);

        if (typeof options.container === 'string') {
            this._container = document.getElementById(options.container);
            if (!this._container) {
                throw new Error(`Container '${options.container}' not found.`);
            }
        } else if (options.container instanceof HTMLElement) {
            this._container = options.container;
        } else {
            throw new Error('Invalid type: \'container\' must be a String or HTMLElement.');
        }

        if (options.maxBounds) {
            this.setMaxBounds(options.maxBounds);
        }

        bindAll([
            '_onWindowOnline',
            '_onWindowResize',
            '_onMapScroll',
            '_contextLost',
            '_contextRestored'
        ], this);

        this._setupContainer();
        this._setupPainter();
        if (this.painter === undefined) {
            throw new Error('Failed to initialize WebGL.');
        }

        this.on('move', () => this._update(false));
        this.on('moveend', () => this._update(false));
        this.on('zoom', () => this._update(true));
        this.on('terrain', () => {
            this.painter.terrainFacilitator.dirty = true;
            this._update(true);
        });

        if (typeof window !== 'undefined') {
            addEventListener('online', this._onWindowOnline, false);
            addEventListener('resize', this._onWindowResize, false);
            addEventListener('orientationchange', this._onWindowResize, false);
        }

        this.handlers = new HandlerManager(this, options as CompleteMapOptions);

        if (this._cooperativeGestures) {
            this._setupCooperativeGestures();
        }

        const hashName = (typeof options.hash === 'string' && options.hash) || undefined;
        this._hash = options.hash && (new Hash(hashName)).addTo(this);
        // don't set position from options if set through hash
        if (!this._hash || !this._hash._onHashChange()) {
            this.jumpTo({
                center: options.center,
                zoom: options.zoom,
                bearing: options.bearing,
                pitch: options.pitch
            });

            if (options.bounds) {
                this.resize();
                this.fitBounds(options.bounds, extend({}, options.fitBoundsOptions, {duration: 0}));
            }
        }

        this.resize();

        this._localIdeographFontFamily = options.localIdeographFontFamily;
        if (options.style) this.setStyle(options.style, {localIdeographFontFamily: options.localIdeographFontFamily});

        if (options.attributionControl)
            this.addControl(new AttributionControl({customAttribution: options.customAttribution}));

        if (options.maplibreLogo)
            this.addControl(new LogoControl(), options.logoPosition);

        this.on('style.load', () => {
            if (this.transform.unmodified) {
                this.jumpTo(this.style.stylesheet as any);
            }
        });
        this.on('data', (event: MapDataEvent) => {
            this._update(event.dataType === 'style');
            this.fire(new Event(`${event.dataType}data`, event));
        });
        this.on('dataloading', (event: MapDataEvent) => {
            this.fire(new Event(`${event.dataType}dataloading`, event));
        });
        this.on('dataabort', (event: MapDataEvent) => {
            this.fire(new Event('sourcedataabort', event));
        });
    }

    /*
    * Returns a unique number for this map instance which is used for the MapLoadEvent
    * to make sure we only fire one event per instantiated map object.
    * @private
    * @returns {number}
    */
    _getMapId() {
        return this._mapId;
    }

    /**
     * Adds an {@link IControl} to the map, calling `control.onAdd(this)`.
     *
     * @param {IControl} control The {@link IControl} to add.
     * @param {string} [position] position on the map to which the control will be added.
     * Valid values are `'top-left'`, `'top-right'`, `'bottom-left'`, and `'bottom-right'`. Defaults to `'top-right'`.
     * @returns {Map} `this`
     * @example
     * // Add zoom and rotation controls to the map.
     * map.addControl(new maplibregl.NavigationControl());
     * @see [Display map navigation controls](https://maplibre.org/maplibre-gl-js-docs/example/navigation/)
     */
    addControl(control: IControl, position?: ControlPosition) {
        if (position === undefined) {
            if (control.getDefaultPosition) {
                position = control.getDefaultPosition();
            } else {
                position = 'top-right';
            }
        }
        if (!control || !control.onAdd) {
            return this.fire(new ErrorEvent(new Error(
                'Invalid argument to map.addControl(). Argument must be a control with onAdd and onRemove methods.')));
        }
        const controlElement = control.onAdd(this);
        this._controls.push(control);

        const positionContainer = this._controlPositions[position];
        if (position.indexOf('bottom') !== -1) {
            positionContainer.insertBefore(controlElement, positionContainer.firstChild);
        } else {
            positionContainer.appendChild(controlElement);
        }
        return this;
    }

    /**
     * Removes the control from the map.
     *
     * @param {IControl} control The {@link IControl} to remove.
     * @returns {Map} `this`
     * @example
     * // Define a new navigation control.
     * var navigation = new maplibregl.NavigationControl();
     * // Add zoom and rotation controls to the map.
     * map.addControl(navigation);
     * // Remove zoom and rotation controls from the map.
     * map.removeControl(navigation);
     */
    removeControl(control: IControl) {
        if (!control || !control.onRemove) {
            return this.fire(new ErrorEvent(new Error(
                'Invalid argument to map.removeControl(). Argument must be a control with onAdd and onRemove methods.')));
        }
        const ci = this._controls.indexOf(control);
        if (ci > -1) this._controls.splice(ci, 1);
        control.onRemove(this);
        return this;
    }

    /**
     * Checks if a control exists on the map.
     *
     * @param {IControl} control The {@link IControl} to check.
     * @returns {boolean} True if map contains control.
     * @example
     * // Define a new navigation control.
     * var navigation = new maplibregl.NavigationControl();
     * // Add zoom and rotation controls to the map.
     * map.addControl(navigation);
     * // Check that the navigation control exists on the map.
     * map.hasControl(navigation);
     */
    hasControl(control: IControl) {
        return this._controls.indexOf(control) > -1;
    }

    /**
     * Resizes the map according to the dimensions of its
     * `container` element.
     *
     * Checks if the map container size changed and updates the map if it has changed.
     * This method must be called after the map's `container` is resized programmatically
     * or when the map is shown after being initially hidden with CSS.
     *
     * @param eventData Additional properties to be passed to `movestart`, `move`, `resize`, and `moveend`
     *   events that get triggered as a result of resize. This can be useful for differentiating the
     *   source of an event (for example, user-initiated or programmatically-triggered events).
     * @returns {Map} `this`
     * @example
     * // Resize the map when the map container is shown
     * // after being initially hidden with CSS.
     * var mapDiv = document.getElementById('map');
     * if (mapDiv.style.visibility === true) map.resize();
     */
    resize(eventData?: any) {
        const dimensions = this._containerDimensions();
        const width = dimensions[0];
        const height = dimensions[1];

        this._resizeCanvas(width, height, this.getPixelRatio());
        this.transform.resize(width, height);
        this.painter.resize(width, height, this.getPixelRatio());

        const fireMoving = !this._moving;
        if (fireMoving) {
            this.stop();
            this.fire(new Event('movestart', eventData))
                .fire(new Event('move', eventData));
        }

        this.fire(new Event('resize', eventData));

        if (fireMoving) this.fire(new Event('moveend', eventData));

        return this;
    }

    /**
     * Returns the map's pixel ratio.
     * @returns {number} The pixel ratio.
     */
    getPixelRatio() {
        return this._pixelRatio;
    }

    /**
     * Sets the map's pixel ratio. This allows to override `devicePixelRatio`.
     * After this call, the canvas' `width` attribute will be `container.clientWidth * pixelRatio`
     * and its height attribute will be `container.clientHeight * pixelRatio`.
     * @param {number} pixelRatio The pixel ratio.
     */
    setPixelRatio(pixelRatio: number) {
        const [width, height] = this._containerDimensions();

        this._pixelRatio = pixelRatio;

        this._resizeCanvas(width, height, pixelRatio);
        this.painter.resize(width, height, pixelRatio);
    }

    /**
     * Returns the map's geographical bounds. When the bearing or pitch is non-zero, the visible region is not
     * an axis-aligned rectangle, and the result is the smallest bounds that encompasses the visible region.
     * @returns {LngLatBounds} The geographical bounds of the map as {@link LngLatBounds}.
     * @example
     * var bounds = map.getBounds();
     */
    getBounds(): LngLatBounds {
        return this.transform.getBounds();
    }

    /**
     * Returns the maximum geographical bounds the map is constrained to, or `null` if none set.
     * @returns The map object.
     * @example
     * var maxBounds = map.getMaxBounds();
     */
    getMaxBounds(): LngLatBounds | null {
        return this.transform.getMaxBounds();
    }

    /**
     * Sets or clears the map's geographical bounds.
     *
     * Pan and zoom operations are constrained within these bounds.
     * If a pan or zoom is performed that would
     * display regions outside these bounds, the map will
     * instead display a position and zoom level
     * as close as possible to the operation's request while still
     * remaining within the bounds.
     *
     * @param {LngLatBoundsLike | null | undefined} bounds The maximum bounds to set. If `null` or `undefined` is provided, the function removes the map's maximum bounds.
     * @returns {Map} `this`
     * @example
     * // Define bounds that conform to the `LngLatBoundsLike` object.
     * var bounds = [
     *   [-74.04728, 40.68392], // [west, south]
     *   [-73.91058, 40.87764]  // [east, north]
     * ];
     * // Set the map's max bounds.
     * map.setMaxBounds(bounds);
     */
    setMaxBounds(bounds?: LngLatBoundsLike | null) {
        this.transform.setMaxBounds(LngLatBounds.convert(bounds));
        return this._update();
    }

    /**
     * Sets or clears the map's minimum zoom level.
     * If the map's current zoom level is lower than the new minimum,
     * the map will zoom to the new minimum.
     *
     * It is not always possible to zoom out and reach the set `minZoom`.
     * Other factors such as map height may restrict zooming. For example,
     * if the map is 512px tall it will not be possible to zoom below zoom 0
     * no matter what the `minZoom` is set to.
     *
     * @param {number | null | undefined} minZoom The minimum zoom level to set (-2 - 24).
     *   If `null` or `undefined` is provided, the function removes the current minimum zoom (i.e. sets it to -2).
     * @returns {Map} `this`
     * @example
     * map.setMinZoom(12.25);
     */
    setMinZoom(minZoom?: number | null) {

        minZoom = minZoom === null || minZoom === undefined ? defaultMinZoom : minZoom;

        if (minZoom >= defaultMinZoom && minZoom <= this.transform.maxZoom) {
            this.transform.minZoom = minZoom;
            this._update();

            if (this.getZoom() < minZoom) this.setZoom(minZoom);

            return this;

        } else throw new Error(`minZoom must be between ${defaultMinZoom} and the current maxZoom, inclusive`);
    }

    /**
     * Returns the map's minimum allowable zoom level.
     *
     * @returns {number} minZoom
     * @example
     * var minZoom = map.getMinZoom();
     */
    getMinZoom() { return this.transform.minZoom; }

    /**
     * Sets or clears the map's maximum zoom level.
     * If the map's current zoom level is higher than the new maximum,
     * the map will zoom to the new maximum.
     *
     * @param {number | null | undefined} maxZoom The maximum zoom level to set.
     *   If `null` or `undefined` is provided, the function removes the current maximum zoom (sets it to 22).
     * @returns {Map} `this`
     * @example
     * map.setMaxZoom(18.75);
     */
    setMaxZoom(maxZoom?: number | null) {

        maxZoom = maxZoom === null || maxZoom === undefined ? defaultMaxZoom : maxZoom;

        if (maxZoom >= this.transform.minZoom) {
            this.transform.maxZoom = maxZoom;
            this._update();

            if (this.getZoom() > maxZoom) this.setZoom(maxZoom);

            return this;

        } else throw new Error('maxZoom must be greater than the current minZoom');
    }

    /**
     * Returns the map's maximum allowable zoom level.
     *
     * @returns {number} maxZoom
     * @example
     * var maxZoom = map.getMaxZoom();
     */
    getMaxZoom() { return this.transform.maxZoom; }

    /**
     * Sets or clears the map's minimum pitch.
     * If the map's current pitch is lower than the new minimum,
     * the map will pitch to the new minimum.
     *
     * @param {number | null | undefined} minPitch The minimum pitch to set (0-85). Values greater than 60 degrees are experimental and may result in rendering issues. If you encounter any, please raise an issue with details in the MapLibre project.
     *   If `null` or `undefined` is provided, the function removes the current minimum pitch (i.e. sets it to 0).
     * @returns {Map} `this`
     */
    setMinPitch(minPitch?: number | null) {

        minPitch = minPitch === null || minPitch === undefined ? defaultMinPitch : minPitch;

        if (minPitch < defaultMinPitch) {
            throw new Error(`minPitch must be greater than or equal to ${defaultMinPitch}`);
        }

        if (minPitch >= defaultMinPitch && minPitch <= this.transform.maxPitch) {
            this.transform.minPitch = minPitch;
            this._update();

            if (this.getPitch() < minPitch) this.setPitch(minPitch);

            return this;

        } else throw new Error(`minPitch must be between ${defaultMinPitch} and the current maxPitch, inclusive`);
    }

    /**
     * Returns the map's minimum allowable pitch.
     *
     * @returns {number} minPitch
     */
    getMinPitch() { return this.transform.minPitch; }

    /**
     * Sets or clears the map's maximum pitch.
     * If the map's current pitch is higher than the new maximum,
     * the map will pitch to the new maximum.
     *
     * @param {number | null | undefined} maxPitch The maximum pitch to set (0-85). Values greater than 60 degrees are experimental and may result in rendering issues. If you encounter any, please raise an issue with details in the MapLibre project.
     *   If `null` or `undefined` is provided, the function removes the current maximum pitch (sets it to 60).
     * @returns {Map} `this`
     */
    setMaxPitch(maxPitch?: number | null) {

        maxPitch = maxPitch === null || maxPitch === undefined ? defaultMaxPitch : maxPitch;

        if (maxPitch > maxPitchThreshold) {
            throw new Error(`maxPitch must be less than or equal to ${maxPitchThreshold}`);
        }

        if (maxPitch >= this.transform.minPitch) {
            this.transform.maxPitch = maxPitch;
            this._update();

            if (this.getPitch() > maxPitch) this.setPitch(maxPitch);

            return this;

        } else throw new Error('maxPitch must be greater than the current minPitch');
    }

    /**
     * Returns the map's maximum allowable pitch.
     *
     * @returns {number} maxPitch
     */
    getMaxPitch() { return this.transform.maxPitch; }

    /**
     * Returns the state of `renderWorldCopies`. If `true`, multiple copies of the world will be rendered side by side beyond -180 and 180 degrees longitude. If set to `false`:
     * - When the map is zoomed out far enough that a single representation of the world does not fill the map's entire
     * container, there will be blank space beyond 180 and -180 degrees longitude.
     * - Features that cross 180 and -180 degrees longitude will be cut in two (with one portion on the right edge of the
     * map and the other on the left edge of the map) at every zoom level.
     * @returns {boolean} renderWorldCopies
     * @example
     * var worldCopiesRendered = map.getRenderWorldCopies();
     * @see [Render world copies](https://maplibre.org/maplibre-gl-js-docs/example/render-world-copies/)
     */
    getRenderWorldCopies() { return this.transform.renderWorldCopies; }

    /**
     * Sets the state of `renderWorldCopies`.
     *
     * @param {boolean} renderWorldCopies If `true`, multiple copies of the world will be rendered side by side beyond -180 and 180 degrees longitude. If set to `false`:
     * - When the map is zoomed out far enough that a single representation of the world does not fill the map's entire
     * container, there will be blank space beyond 180 and -180 degrees longitude.
     * - Features that cross 180 and -180 degrees longitude will be cut in two (with one portion on the right edge of the
     * map and the other on the left edge of the map) at every zoom level.
     *
     * `undefined` is treated as `true`, `null` is treated as `false`.
     * @returns {Map} `this`
     * @example
     * map.setRenderWorldCopies(true);
     * @see [Render world copies](https://maplibre.org/maplibre-gl-js-docs/example/render-world-copies/)
     */
    setRenderWorldCopies(renderWorldCopies?: boolean | null) {
        this.transform.renderWorldCopies = renderWorldCopies;
        return this._update();
    }

    /**
     * Returns a [Point](https://github.com/mapbox/point-geometry) representing pixel coordinates, relative to the map's `container`,
     * that correspond to the specified geographical location.
     *
     * @param {LngLatLike} lnglat The geographical location to project.
     * @returns {Point} The [Point](https://github.com/mapbox/point-geometry) corresponding to `lnglat`, relative to the map's `container`.
     * @example
     * var coordinate = [-122.420679, 37.772537];
     * var point = map.project(coordinate);
     */
    project(lnglat: LngLatLike) {
        return this.transform.locationPoint(LngLat.convert(lnglat), this.style && this.style.terrain);
    }

    /**
     * Returns a {@link LngLat} representing geographical coordinates that correspond
     * to the specified pixel coordinates.
     *
     * @param {PointLike} point The pixel coordinates to unproject.
     * @returns {LngLat} The {@link LngLat} corresponding to `point`.
     * @example
     * map.on('click', function(e) {
     *   // When the map is clicked, get the geographic coordinate.
     *   var coordinate = map.unproject(e.point);
     * });
     */
    unproject(point: PointLike) {
        return this.transform.pointLocation(Point.convert(point), this.style && this.style.terrain);
    }

    /**
     * Returns true if the map is panning, zooming, rotating, or pitching due to a camera animation or user gesture.
     * @returns {boolean} True if the map is moving.
     * @example
     * var isMoving = map.isMoving();
     */
    isMoving(): boolean {
        return this._moving || this.handlers.isMoving();
    }

    /**
     * Returns true if the map is zooming due to a camera animation or user gesture.
     * @returns {boolean} True if the map is zooming.
     * @example
     * var isZooming = map.isZooming();
     */
    isZooming(): boolean {
        return this._zooming || this.handlers.isZooming();
    }

    /**
     * Returns true if the map is rotating due to a camera animation or user gesture.
     * @returns {boolean} True if the map is rotating.
     * @example
     * map.isRotating();
     */
    isRotating(): boolean {
        return this._rotating || this.handlers.isRotating();
    }

    _createDelegatedListener(type: MapEvent | string, layerId: string, listener: Listener):
    {
        layer: string;
        listener: Listener;
        delegates: {[type in keyof MapEventType]?: (e: any) => void};
    } {
        if (type === 'mouseenter' || type === 'mouseover') {
            let mousein = false;
            const mousemove = (e) => {
                const features = this.getLayer(layerId) ? this.queryRenderedFeatures(e.point, {layers: [layerId]}) : [];
                if (!features.length) {
                    mousein = false;
                } else if (!mousein) {
                    mousein = true;
                    listener.call(this, new MapMouseEvent(type, this, e.originalEvent, {features}));
                }
            };
            const mouseout = () => {
                mousein = false;
            };
            return {layer: layerId, listener, delegates: {mousemove, mouseout}};
        } else if (type === 'mouseleave' || type === 'mouseout') {
            let mousein = false;
            const mousemove = (e) => {
                const features = this.getLayer(layerId) ? this.queryRenderedFeatures(e.point, {layers: [layerId]}) : [];
                if (features.length) {
                    mousein = true;
                } else if (mousein) {
                    mousein = false;
                    listener.call(this, new MapMouseEvent(type, this, e.originalEvent));
                }
            };
            const mouseout = (e) => {
                if (mousein) {
                    mousein = false;
                    listener.call(this, new MapMouseEvent(type, this, e.originalEvent));
                }
            };
            return {layer: layerId, listener, delegates: {mousemove, mouseout}};
        } else {
            const delegate = (e) => {
                const features = this.getLayer(layerId) ? this.queryRenderedFeatures(e.point, {layers: [layerId]}) : [];
                if (features.length) {
                    // Here we need to mutate the original event, so that preventDefault works as expected.
                    e.features = features;
                    listener.call(this, e);
                    delete e.features;
                }
            };
            return {layer: layerId, listener, delegates: {[type]: delegate}};
        }
    }

    /**
     * Adds a listener for events of a specified type, optionally limited to features in a specified style layer.
     *
     * @param {string} type The event type to listen for. Events compatible with the optional `layerId` parameter are triggered
     * when the cursor enters a visible portion of the specified layer from outside that layer or outside the map canvas.
     *
     * | Event                                                     | Compatible with `layerId` |
     * |-----------------------------------------------------------|---------------------------|
     * | [`mousedown`](#map.event:mousedown)                       | yes                       |
     * | [`mouseup`](#map.event:mouseup)                           | yes                       |
     * | [`mouseover`](#map.event:mouseover)                       | yes                       |
     * | [`mouseout`](#map.event:mouseout)                         | yes                       |
     * | [`mousemove`](#map.event:mousemove)                       | yes                       |
     * | [`mouseenter`](#map.event:mouseenter)                     | yes (required)            |
     * | [`mouseleave`](#map.event:mouseleave)                     | yes (required)            |
     * | [`click`](#map.event:click)                               | yes                       |
     * | [`dblclick`](#map.event:dblclick)                         | yes                       |
     * | [`contextmenu`](#map.event:contextmenu)                   | yes                       |
     * | [`touchstart`](#map.event:touchstart)                     | yes                       |
     * | [`touchend`](#map.event:touchend)                         | yes                       |
     * | [`touchcancel`](#map.event:touchcancel)                   | yes                       |
     * | [`wheel`](#map.event:wheel)                               |                           |
     * | [`resize`](#map.event:resize)                             |                           |
     * | [`remove`](#map.event:remove)                             |                           |
     * | [`touchmove`](#map.event:touchmove)                       |                           |
     * | [`movestart`](#map.event:movestart)                       |                           |
     * | [`move`](#map.event:move)                                 |                           |
     * | [`moveend`](#map.event:moveend)                           |                           |
     * | [`dragstart`](#map.event:dragstart)                       |                           |
     * | [`drag`](#map.event:drag)                                 |                           |
     * | [`dragend`](#map.event:dragend)                           |                           |
     * | [`zoomstart`](#map.event:zoomstart)                       |                           |
     * | [`zoom`](#map.event:zoom)                                 |                           |
     * | [`zoomend`](#map.event:zoomend)                           |                           |
     * | [`rotatestart`](#map.event:rotatestart)                   |                           |
     * | [`rotate`](#map.event:rotate)                             |                           |
     * | [`rotateend`](#map.event:rotateend)                       |                           |
     * | [`pitchstart`](#map.event:pitchstart)                     |                           |
     * | [`pitch`](#map.event:pitch)                               |                           |
     * | [`pitchend`](#map.event:pitchend)                         |                           |
     * | [`boxzoomstart`](#map.event:boxzoomstart)                 |                           |
     * | [`boxzoomend`](#map.event:boxzoomend)                     |                           |
     * | [`boxzoomcancel`](#map.event:boxzoomcancel)               |                           |
     * | [`webglcontextlost`](#map.event:webglcontextlost)         |                           |
     * | [`webglcontextrestored`](#map.event:webglcontextrestored) |                           |
     * | [`load`](#map.event:load)                                 |                           |
     * | [`render`](#map.event:render)                             |                           |
     * | [`idle`](#map.event:idle)                                 |                           |
     * | [`error`](#map.event:error)                               |                           |
     * | [`data`](#map.event:data)                                 |                           |
     * | [`styledata`](#map.event:styledata)                       |                           |
     * | [`sourcedata`](#map.event:sourcedata)                     |                           |
     * | [`dataloading`](#map.event:dataloading)                   |                           |
     * | [`styledataloading`](#map.event:styledataloading)         |                           |
     * | [`sourcedataloading`](#map.event:sourcedataloading)       |                           |
     * | [`styleimagemissing`](#map.event:styleimagemissing)       |                           |
     * | [`dataabort`](#map.event:dataabort)                       |                           |
     * | [`sourcedataabort`](#map.event:sourcedataabort)           |                           |
     *
     * @param {string | Listener} layer The ID of a style layer or a listener if no ID is provided. Event will only be triggered if its location
     * is within a visible feature in this layer. The event will have a `features` property containing
     * an array of the matching features. If `layerIdOrListener` is not supplied, the event will not have a `features` property.
     * Please note that many event types are not compatible with the optional `layerIdOrListener` parameter.
     * @param {Function} listener The function to be called when the event is fired.
     * @returns {Map} `this`
     * @example
     * // Set an event listener that will fire
     * // when the map has finished loading
     * map.on('load', function() {
     *   // Once the map has finished loading,
     *   // add a new layer
     *   map.addLayer({
     *     id: 'points-of-interest',
     *     source: {
     *       type: 'vector',
     *       url: 'https://maplibre.org/maplibre-gl-js-docs/style-spec/'
     *     },
     *     'source-layer': 'poi_label',
     *     type: 'circle',
     *     paint: {
     *       // MapLibre Style Specification paint properties
     *     },
     *     layout: {
     *       // MapLibre Style Specification layout properties
     *     }
     *   });
     * });
     * @example
     * // Set an event listener that will fire
     * // when a feature on the countries layer of the map is clicked
     * map.on('click', 'countries', function(e) {
     *   new maplibregl.Popup()
     *     .setLngLat(e.lngLat)
     *     .setHTML(`Country name: ${e.features[0].properties.name}`)
     *     .addTo(map);
     * });
     * @see [Display popup on click](https://maplibre.org/maplibre-gl-js-docs/example/popup-on-click/)
     * @see [Center the map on a clicked symbol](https://maplibre.org/maplibre-gl-js-docs/example/center-on-symbol/)
     * @see [Create a hover effect](https://maplibre.org/maplibre-gl-js-docs/example/hover-styles/)
     * @see [Create a draggable marker](https://maplibre.org/maplibre-gl-js-docs/example/drag-a-point/)
     */
    on<T extends keyof MapLayerEventType>(
        type: T,
        layer: string,
        listener: (ev: MapLayerEventType[T] & Object) => void,
    ): this;
    on<T extends keyof MapEventType>(type: T, listener: (ev: MapEventType[T] & Object) => void): this;
    on(type: MapEvent | string, listener: Listener): this;
    on(type: MapEvent | string, layerIdOrListener: string | Listener, listener?: Listener): this {
        if (listener === undefined) {
            return super.on(type, layerIdOrListener as Listener);
        }

        const delegatedListener = this._createDelegatedListener(type, layerIdOrListener as string, listener);

        this._delegatedListeners = this._delegatedListeners || {};
        this._delegatedListeners[type] = this._delegatedListeners[type] || [];
        this._delegatedListeners[type].push(delegatedListener);

        for (const event in delegatedListener.delegates) {
            this.on(event as MapEvent, delegatedListener.delegates[event]);
        }

        return this;
    }

    /**
     * Adds a listener that will be called only once to a specified event type.
     *
     * @method
     * @name once
     * @memberof Map
     * @instance
     * @param {string} type The event type to add a listener for.
     * @param {Function} listener The function to be called when the event is fired.
     *   The listener function is called with the data object passed to `fire`,
     *   extended with `target` and `type` properties.
     * @returns {Map} `this`
     */

    /**
     * Adds a listener that will be called only once to a specified event type occurring on features in a specified style layer.
     *
     * @param {string} type The event type to listen for; one of `'mousedown'`, `'mouseup'`, `'click'`, `'dblclick'`,
     * `'mousemove'`, `'mouseenter'`, `'mouseleave'`, `'mouseover'`, `'mouseout'`, `'contextmenu'`, `'touchstart'`,
     * `'touchend'`, or `'touchcancel'`. `mouseenter` and `mouseover` events are triggered when the cursor enters
     * a visible portion of the specified layer from outside that layer or outside the map canvas. `mouseleave`
     * and `mouseout` events are triggered when the cursor leaves a visible portion of the specified layer, or leaves
     * the map canvas.
     * @param {string} layer The ID of a style layer or a listener if no ID is provided. Only events whose location is within a visible
     * feature in this layer will trigger the listener. The event will have a `features` property containing
     * an array of the matching features.
     * @param {Function} listener The function to be called when the event is fired.
     * @returns {Map} `this`
     */
    once<T extends keyof MapLayerEventType>(
        type: T,
        layer: string,
        listener: (ev: MapLayerEventType[T] & Object) => void,
    ): this;
    once<T extends keyof MapEventType>(type: T, listener: (ev: MapEventType[T] & Object) => void): this;
    once(type: MapEvent | string, listener: Listener): this;
    once(type: MapEvent | string, layerIdOrListener: string | Listener, listener?: Listener): this {

        if (listener === undefined) {
            return super.once(type, layerIdOrListener as Listener);
        }

        const delegatedListener = this._createDelegatedListener(type, layerIdOrListener as string, listener);

        for (const event in delegatedListener.delegates) {
            this.once(event as MapEvent, delegatedListener.delegates[event]);
        }

        return this;
    }

    /**
     * Removes an event listener previously added with `Map#on`.
     *
     * @method
     * @name off
     * @memberof Map
     * @instance
     * @param {string} type The event type previously used to install the listener.
     * @param {Function} listener The function previously installed as a listener.
     * @returns {Map} `this`
     */

    /**
     * Removes an event listener for layer-specific events previously added with `Map#on`.
     *
     * @param {string} type The event type previously used to install the listener.
     * @param {string} layer The layer ID or listener previously used to install the listener.
     * @param {Function} listener The function previously installed as a listener.
     * @returns {Map} `this`
     */
    off<T extends keyof MapLayerEventType>(
        type: T,
        layer: string,
        listener: (ev: MapLayerEventType[T] & Object) => void,
    ): this;
    off<T extends keyof MapEventType>(type: T, listener: (ev: MapEventType[T] & Object) => void): this;
    off(type: MapEvent | string, listener: Listener): this;
    off(type: MapEvent | string, layerIdOrListener: string | Listener, listener?: Listener): this {
        if (listener === undefined) {
            return super.off(type, layerIdOrListener as Listener);
        }

        const removeDelegatedListener = (delegatedListeners) => {
            const listeners = delegatedListeners[type];
            for (let i = 0; i < listeners.length; i++) {
                const delegatedListener = listeners[i];
                if (delegatedListener.layer === layerIdOrListener && delegatedListener.listener === listener) {
                    for (const event in delegatedListener.delegates) {
                        this.off(((event as any)), delegatedListener.delegates[event]);
                    }
                    listeners.splice(i, 1);
                    return this;
                }
            }
        };

        if (this._delegatedListeners && this._delegatedListeners[type]) {
            removeDelegatedListener(this._delegatedListeners);
        }

        return this;
    }

    /**
     * Returns an array of MapGeoJSONFeature objects
     * representing visible features that satisfy the query parameters.
     *
     * @param {PointLike|Array<PointLike>} [geometry] - The geometry of the query region:
     * either a single point or southwest and northeast points describing a bounding box.
     * Omitting this parameter (i.e. calling {@link Map#queryRenderedFeatures} with zero arguments,
     * or with only a `options` argument) is equivalent to passing a bounding box encompassing the entire
     * map viewport.
     * @param {Object} [options] Options object.
     * @param {Array<string>} [options.layers] An array of [style layer IDs](https://maplibre.org/maplibre-gl-js-docs/style-spec/#layer-id) for the query to inspect.
     *   Only features within these layers will be returned. If this parameter is undefined, all layers will be checked.
     * @param {Array} [options.filter] A [filter](https://maplibre.org/maplibre-gl-js-docs/style-spec/layers/#filter)
     *   to limit query results.
     * @param {boolean} [options.validate=true] Whether to check if the [options.filter] conforms to the MapLibre GL Style Specification. Disabling validation is a performance optimization that should only be used if you have previously validated the values you will be passing to this function.
     *
     * @returns {Array<MapGeoJSONFeature>} An array of MapGeoJSONFeature objects.
     *
     * The `properties` value of each returned feature object contains the properties of its source feature. For GeoJSON sources, only
     * string and numeric property values are supported (i.e. `null`, `Array`, and `Object` values are not supported).
     *
     * Each feature includes top-level `layer`, `source`, and `sourceLayer` properties. The `layer` property is an object
     * representing the style layer to  which the feature belongs. Layout and paint properties in this object contain values
     * which are fully evaluated for the given zoom level and feature.
     *
     * Only features that are currently rendered are included. Some features will **not** be included, like:
     *
     * - Features from layers whose `visibility` property is `"none"`.
     * - Features from layers whose zoom range excludes the current zoom level.
     * - Symbol features that have been hidden due to text or icon collision.
     *
     * Features from all other layers are included, including features that may have no visible
     * contribution to the rendered result; for example, because the layer's opacity or color alpha component is set to
     * 0.
     *
     * The topmost rendered feature appears first in the returned array, and subsequent features are sorted by
     * descending z-order. Features that are rendered multiple times (due to wrapping across the antimeridian at low
     * zoom levels) are returned only once (though subject to the following caveat).
     *
     * Because features come from tiled vector data or GeoJSON data that is converted to tiles internally, feature
     * geometries may be split or duplicated across tile boundaries and, as a result, features may appear multiple
     * times in query results. For example, suppose there is a highway running through the bounding rectangle of a query.
     * The results of the query will be those parts of the highway that lie within the map tiles covering the bounding
     * rectangle, even if the highway extends into other tiles, and the portion of the highway within each map tile
     * will be returned as a separate feature. Similarly, a point feature near a tile boundary may appear in multiple
     * tiles due to tile buffering.
     *
     * @example
     * // Find all features at a point
     * var features = map.queryRenderedFeatures(
     *   [20, 35],
     *   { layers: ['my-layer-name'] }
     * );
     *
     * @example
     * // Find all features within a static bounding box
     * var features = map.queryRenderedFeatures(
     *   [[10, 20], [30, 50]],
     *   { layers: ['my-layer-name'] }
     * );
     *
     * @example
     * // Find all features within a bounding box around a point
     * var width = 10;
     * var height = 20;
     * var features = map.queryRenderedFeatures([
     *   [point.x - width / 2, point.y - height / 2],
     *   [point.x + width / 2, point.y + height / 2]
     * ], { layers: ['my-layer-name'] });
     *
     * @example
     * // Query all rendered features from a single layer
     * var features = map.queryRenderedFeatures({ layers: ['my-layer-name'] });
     * @see [Get features under the mouse pointer](https://maplibre.org/maplibre-gl-js-docs/example/queryrenderedfeatures/)
     */
    queryRenderedFeatures(geometry?: PointLike | [PointLike, PointLike], options?: any): MapGeoJSONFeature[] {
        // The first parameter can be omitted entirely, making this effectively an overloaded method
        // with two signatures:
        //
        //     queryRenderedFeatures(geometry: PointLike | [PointLike, PointLike], options?: Object)
        //     queryRenderedFeatures(options?: Object)
        //
        // There no way to express that in a way that's compatible with both flow and documentation.js.
        // Related: https://github.com/facebook/flow/issues/1556

        if (!this.style) {
            return [];
        }

        if (options === undefined && geometry !== undefined && !(geometry instanceof Point) && !Array.isArray(geometry)) {
            options = geometry;
            geometry = undefined;
        }

        options = options || {};
        geometry = geometry || [[0, 0], [this.transform.width, this.transform.height]];

        let queryGeometry;
        if (geometry instanceof Point || typeof geometry[0] === 'number') {
            queryGeometry = [Point.convert(geometry as PointLike)];
        } else {
            const tl = Point.convert(geometry[0] as PointLike);
            const br = Point.convert(geometry[1] as PointLike);
            queryGeometry = [tl, new Point(br.x, tl.y), br, new Point(tl.x, br.y), tl];
        }

        return this.style.queryRenderedFeatures(queryGeometry, options, this.transform);
    }

    /**
     * Returns an array of MapGeoJSONFeature objects
     * representing features within the specified vector tile or GeoJSON source that satisfy the query parameters.
     *
     * @param {string} sourceId The ID of the vector tile or GeoJSON source to query.
     * @param {Object} [parameters] Options object.
     * @param {string} [parameters.sourceLayer] The name of the source layer
     *   to query. *For vector tile sources, this parameter is required.* For GeoJSON sources, it is ignored.
     * @param {Array} [parameters.filter] A [filter](https://maplibre.org/maplibre-gl-js-docs/style-spec/layers/#filter)
     *   to limit query results.
     * @param {boolean} [parameters.validate=true] Whether to check if the [parameters.filter] conforms to the MapLibre GL Style Specification. Disabling validation is a performance optimization that should only be used if you have previously validated the values you will be passing to this function.
     *
     * @returns {Array<MapGeoJSONFeature>} An array of MapGeoJSONFeature objects.
     *
     * In contrast to {@link Map#queryRenderedFeatures}, this function returns all features matching the query parameters,
     * whether or not they are rendered by the current style (i.e. visible). The domain of the query includes all currently-loaded
     * vector tiles and GeoJSON source tiles: this function does not check tiles outside the currently
     * visible viewport.
     *
     * Because features come from tiled vector data or GeoJSON data that is converted to tiles internally, feature
     * geometries may be split or duplicated across tile boundaries and, as a result, features may appear multiple
     * times in query results. For example, suppose there is a highway running through the bounding rectangle of a query.
     * The results of the query will be those parts of the highway that lie within the map tiles covering the bounding
     * rectangle, even if the highway extends into other tiles, and the portion of the highway within each map tile
     * will be returned as a separate feature. Similarly, a point feature near a tile boundary may appear in multiple
     * tiles due to tile buffering.
     *
     * @example
     * // Find all features in one source layer in a vector source
     * var features = map.querySourceFeatures('your-source-id', {
     *   sourceLayer: 'your-source-layer'
     * });
     *
     */
    querySourceFeatures(sourceId: string, parameters?: {
        sourceLayer: string;
        filter: Array<any>;
        validate?: boolean;
    } | null): MapGeoJSONFeature[] {
        return this.style.querySourceFeatures(sourceId, parameters);
    }

    /**
     * Updates the map's MapLibre style object with a new value.
     *
     * If a style is already set when this is used and options.diff is set to true, the map renderer will attempt to compare the given style
     * against the map's current state and perform only the changes necessary to make the map style match the desired state. Changes in sprites
     * (images used for icons and patterns) and glyphs (fonts for label text) **cannot** be diffed. If the sprites or fonts used in the current
     * style and the given style are different in any way, the map renderer will force a full update, removing the current style and building
     * the given one from scratch.
     *
     *
     * @param style A JSON object conforming to the schema described in the
     *   [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/), or a URL to such JSON.
     * @param {Object} [options] Options object.
     * @param {boolean} [options.diff=true] If false, force a 'full' update, removing the current style
     *   and building the given one instead of attempting a diff-based update.
     * @param {string} [options.localIdeographFontFamily='sans-serif'] Defines a CSS
     *   font-family for locally overriding generation of glyphs in the 'CJK Unified Ideographs', 'Hiragana', 'Katakana' and 'Hangul Syllables' ranges.
     *   In these ranges, font settings from the map's style will be ignored, except for font-weight keywords (light/regular/medium/bold).
     *   Set to `false`, to enable font settings from the map's style for these glyph ranges.
     *   Forces a full update.
     * @returns {Map} `this`
     *
     * @example
     * map.setStyle("https://demotiles.maplibre.org/style.json");
     *
     */
    setStyle(style: StyleSpecification | string | null, options?: {
        diff?: boolean;
    } & StyleOptions) {
        options = extend({}, {localIdeographFontFamily: this._localIdeographFontFamily}, options);

        if ((options.diff !== false && options.localIdeographFontFamily === this._localIdeographFontFamily) && this.style && style) {
            this._diffStyle(style, options);
            return this;
        } else {
            this._localIdeographFontFamily = options.localIdeographFontFamily;
            return this._updateStyle(style, options);
        }
    }

    /**
     *  Updates the requestManager's transform request with a new function
     *
     * @param transformRequest A callback run before the Map makes a request for an external URL. The callback can be used to modify the url, set headers, or set the credentials property for cross-origin requests.
     *    Expected to return an object with a `url` property and optionally `headers` and `credentials` properties
     *
     * @returns {Map} `this`
     *
     *  @example
     *  map.setTransformRequest((url: string, resourceType: string) => {});
     */
    setTransformRequest(transformRequest: RequestTransformFunction) {
        this._requestManager.setTransformRequest(transformRequest);
        return this;
    }

    _getUIString(key: string) {
        const str = this._locale[key];
        if (str == null) {
            throw new Error(`Missing UI string '${key}'`);
        }

        return str;
    }

    _updateStyle(style: StyleSpecification | string | null,  options?: {
        diff?: boolean;
    } & StyleOptions) {
        if (this.style) {
            this.style.setEventedParent(null);
            this.style._remove();
        }

        if (!style) {
            delete this.style;
            return this;
        } else {
            this.style = new Style(this, options || {});
        }

        this.style.setEventedParent(this, {style: this.style});

        if (typeof style === 'string') {
            this.style.loadURL(style);
        } else {
            this.style.loadJSON(style);
        }

        return this;
    }

    _lazyInitEmptyStyle() {
        if (!this.style) {
            this.style = new Style(this, {});
            this.style.setEventedParent(this, {style: this.style});
            this.style.loadEmpty();
        }
    }

    _diffStyle(style: StyleSpecification | string,  options?: {
        diff?: boolean;
    } & StyleOptions) {
        if (typeof style === 'string') {
            const url = style;
            const request = this._requestManager.transformRequest(url, ResourceType.Style);
            getJSON(request, (error?: Error | null, json?: any | null) => {
                if (error) {
                    this.fire(new ErrorEvent(error));
                } else if (json) {
                    this._updateDiff(json, options);
                }
            });
        } else if (typeof style === 'object') {
            this._updateDiff(style, options);
        }
    }

    _updateDiff(style: StyleSpecification,  options?: {
        diff?: boolean;
    } & StyleOptions) {
        try {
            if (this.style.setState(style)) {
                this._update(true);
            }
        } catch (e) {
            warnOnce(
                `Unable to perform style diff: ${e.message || e.error || e}.  Rebuilding the style from scratch.`
            );
            this._updateStyle(style, options);
        }
    }

    /**
     * Returns the map's MapLibre style object, a JSON object which can be used to recreate the map's style.
     *
     * @returns {Object} The map's style JSON object.
     *
     * @example
     * var styleJson = map.getStyle();
     *
     */
    getStyle(): StyleSpecification {
        if (this.style) {
            return this.style.serialize();
        }
    }

    /**
     * Returns a Boolean indicating whether the map's style is fully loaded.
     *
     * @returns {boolean} A Boolean indicating whether the style is fully loaded.
     *
     * @example
     * var styleLoadStatus = map.isStyleLoaded();
     */
    isStyleLoaded() {
        if (!this.style) return warnOnce('There is no style added to the map.');
        return this.style.loaded();
    }

    /**
     * Adds a source to the map's style.
     *
     * @param {string} id The ID of the source to add. Must not conflict with existing sources.
     * @param {Object} source The source object, conforming to the
     * MapLibre Style Specification's [source definition](https://maplibre.org/maplibre-gl-js-docs/style-spec/#sources) or
     * {@link CanvasSourceOptions}.
     * @fires source.add
     * @returns {Map} `this`
     * @example
     * map.addSource('my-data', {
     *   type: 'vector',
     *   url: 'https://demotiles.maplibre.org/tiles/tiles.json'
     * });
     * @example
     * map.addSource('my-data', {
     *   "type": "geojson",
     *   "data": {
     *     "type": "Feature",
     *     "geometry": {
     *       "type": "Point",
     *       "coordinates": [-77.0323, 38.9131]
     *     },
     *     "properties": {
     *       "title": "Mapbox DC",
     *       "marker-symbol": "monument"
     *     }
     *   }
     * });
     * @see GeoJSON source: [Add live realtime data](https://maplibre.org/maplibre-gl-js-docs/example/live-geojson/)
     */
    addSource(id: string, source: SourceSpecification) {
        this._lazyInitEmptyStyle();
        this.style.addSource(id, source);
        return this._update(true);
    }

    /**
     * Returns a Boolean indicating whether the source is loaded. Returns `true` if the source with
     * the given ID in the map's style has no outstanding network requests, otherwise `false`.
     *
     * @param {string} id The ID of the source to be checked.
     * @returns {boolean} A Boolean indicating whether the source is loaded.
     * @example
     * var sourceLoaded = map.isSourceLoaded('bathymetry-data');
     */
    isSourceLoaded(id: string) {
        const source = this.style && this.style.sourceCaches[id];
        if (source === undefined) {
            this.fire(new ErrorEvent(new Error(`There is no source with ID '${id}'`)));
            return;
        }
        return source.loaded();
    }

    /**
     * Loads a 3D terrain mesh, based on a "raster-dem" source.
     * @param {TerrainSpecification} [options] Options object.
     * @returns {Map} `this`
     * @example
     * map.setTerrain({ source: 'terrain' });
     */
    setTerrain(options: TerrainSpecification): Map {
        this.style.setTerrain(options);
        return this;
    }

    /**
     * Get the terrain-options if terrain is loaded
     * @returns {TerrainSpecification} the TerrainSpecification passed to setTerrain
     * @example
     * map.getTerrain(); // { source: 'terrain' };
     */
    getTerrain(): TerrainSpecification {
        return this.style.terrain && this.style.terrain.options;
    }

    /**
     * Returns a Boolean indicating whether all tiles in the viewport from all sources on
     * the style are loaded.
     *
     * @returns {boolean} A Boolean indicating whether all tiles are loaded.
     * @example
     * var tilesLoaded = map.areTilesLoaded();
     */
    areTilesLoaded(): boolean {
        const sources = this.style && this.style.sourceCaches;
        for (const id in sources) {
            const source = sources[id];
            const tiles = source._tiles;
            for (const t in tiles) {
                const tile = tiles[t];
                if (!(tile.state === 'loaded' || tile.state === 'errored')) return false;
            }
        }
        return true;
    }

    /**
     * Adds a [custom source type](#Custom Sources), making it available for use with
     * {@link Map#addSource}.
     * @private
     * @param {string} name The name of the source type; source definition objects use this name in the `{type: ...}` field.
     * @param {Function} SourceType A {@link Source} constructor.
     * @param {Callback<void>} callback Called when the source type is ready or with an error argument if there is an error.
     */
    addSourceType(name: string, SourceType: any, callback: Callback<void>) {
        this._lazyInitEmptyStyle();
        return this.style.addSourceType(name, SourceType, callback);
    }

    /**
     * Removes a source from the map's style.
     *
     * @param {string} id The ID of the source to remove.
     * @returns {Map} `this`
     * @example
     * map.removeSource('bathymetry-data');
     */
    removeSource(id: string): Map {
        this.style.removeSource(id);
        return this._update(true);
    }

    /**
     * Returns the source with the specified ID in the map's style.
     *
     * This method is often used to update a source using the instance members for the relevant
     * source type as defined in [Sources](#sources).
     * For example, setting the `data` for a GeoJSON source or updating the `url` and `coordinates`
     * of an image source.
     *
     * @param {string} id The ID of the source to get.
     * @returns {Source | undefined} The style source with the specified ID or `undefined` if the ID
     * corresponds to no existing sources.
     * The shape of the object varies by source type.
     * A list of options for each source type is available on the MapLibre Style Specification's
     * [Sources](https://maplibre.org/maplibre-gl-js-docs/style-spec/sources/) page.
     * @example
     * var sourceObject = map.getSource('points');
     * @see [Create a draggable point](https://maplibre.org/maplibre-gl-js-docs/example/drag-a-point/)
     * @see [Animate a point](https://maplibre.org/maplibre-gl-js-docs/example/animate-point-along-line/)
     * @see [Add live realtime data](https://maplibre.org/maplibre-gl-js-docs/example/live-geojson/)
     */
    getSource(id: string): Source | undefined {
        return this.style.getSource(id);
    }

    // eslint-disable-next-line jsdoc/require-returns
    /**
     * Add an image to the style. This image can be displayed on the map like any other icon in the style's
     * sprite using the image's ID with
     * [`icon-image`](https://maplibre.org/maplibre-gl-js-docs/style-spec/#layout-symbol-icon-image),
     * [`background-pattern`](https://maplibre.org/maplibre-gl-js-docs/style-spec/#paint-background-background-pattern),
     * [`fill-pattern`](https://maplibre.org/maplibre-gl-js-docs/style-spec/#paint-fill-fill-pattern),
     * or [`line-pattern`](https://maplibre.org/maplibre-gl-js-docs/style-spec/#paint-line-line-pattern).
     * A {@link Map.event:error} event will be fired if there is not enough space in the sprite to add this image.
     *
     * @param id The ID of the image.
     * @param image The image as an `HTMLImageElement`, `ImageData`, `ImageBitmap` or object with `width`, `height`, and `data`
     * properties with the same format as `ImageData`.
     * @param options Options object.
     * @param options.pixelRatio The ratio of pixels in the image to physical pixels on the screen
     * @param options.sdf Whether the image should be interpreted as an SDF image
     * @param options.content `[x1, y1, x2, y2]`  If `icon-text-fit` is used in a layer with this image, this option defines the part of the image that can be covered by the content in `text-field`.
     * @param options.stretchX `[[x1, x2], ...]` If `icon-text-fit` is used in a layer with this image, this option defines the part(s) of the image that can be stretched horizontally.
     * @param options.stretchY `[[y1, y2], ...]` If `icon-text-fit` is used in a layer with this image, this option defines the part(s) of the image that can be stretched vertically.
     *
     * @example
     * // If the style's sprite does not already contain an image with ID 'cat',
     * // add the image 'cat-icon.png' to the style's sprite with the ID 'cat'.
     * map.loadImage('https://upload.wikimedia.org/wikipedia/commons/thumb/6/60/Cat_silhouette.svg/400px-Cat_silhouette.svg.png', function(error, image) {
     *    if (error) throw error;
     *    if (!map.hasImage('cat')) map.addImage('cat', image);
     * });
     *
     *
     * // Add a stretchable image that can be used with `icon-text-fit`
     * // In this example, the image is 600px wide by 400px high.
     * map.loadImage('https://upload.wikimedia.org/wikipedia/commons/8/89/Black_and_White_Boxed_%28bordered%29.png', function(error, image) {
     *    if (error) throw error;
     *    if (!map.hasImage('border-image')) {
     *      map.addImage('border-image', image, {
     *          content: [16, 16, 300, 384], // place text over left half of image, avoiding the 16px border
     *          stretchX: [[16, 584]], // stretch everything horizontally except the 16px border
     *          stretchY: [[16, 384]], // stretch everything vertically except the 16px border
     *      });
     *    }
     * });
     *
     *
     * @see Use `HTMLImageElement`: [Add an icon to the map](https://maplibre.org/maplibre-gl-js-docs/example/add-image/)
     * @see Use `ImageData`: [Add a generated icon to the map](https://maplibre.org/maplibre-gl-js-docs/example/add-image-generated/)
     */
    addImage(id: string,
        image: HTMLImageElement | ImageBitmap | ImageData | {
            width: number;
            height: number;
            data: Uint8Array | Uint8ClampedArray;
        } | StyleImageInterface,
        {
            pixelRatio = 1,
            sdf = false,
            stretchX,
            stretchY,
            content
        }: Partial<StyleImageMetadata> = {}) {
        this._lazyInitEmptyStyle();
        const version = 0;

        if (image instanceof HTMLImageElement || isImageBitmap(image)) {
            const {width, height, data} = browser.getImageData(image);
            this.style.addImage(id, {data: new RGBAImage({width, height}, data), pixelRatio, stretchX, stretchY, content, sdf, version});
        } else if (image.width === undefined || image.height === undefined) {
            return this.fire(new ErrorEvent(new Error(
                'Invalid arguments to map.addImage(). The second argument must be an `HTMLImageElement`, `ImageData`, `ImageBitmap`, ' +
                'or object with `width`, `height`, and `data` properties with the same format as `ImageData`')));
        } else {
            const {width, height, data} = image as ImageData;
            const userImage = (image as any as StyleImageInterface);

            this.style.addImage(id, {
                data: new RGBAImage({width, height}, new Uint8Array(data)),
                pixelRatio,
                stretchX,
                stretchY,
                content,
                sdf,
                version,
                userImage
            });

            if (userImage.onAdd) {
                userImage.onAdd(this, id);
            }
        }
    }

    // eslint-disable-next-line jsdoc/require-returns
    /**
     * Update an existing image in a style. This image can be displayed on the map like any other icon in the style's
     * sprite using the image's ID with
     * [`icon-image`](https://maplibre.org/maplibre-gl-js-docs/style-spec/#layout-symbol-icon-image),
     * [`background-pattern`](https://maplibre.org/maplibre-gl-js-docs/style-spec/#paint-background-background-pattern),
     * [`fill-pattern`](https://maplibre.org/maplibre-gl-js-docs/style-spec/#paint-fill-fill-pattern),
     * or [`line-pattern`](https://maplibre.org/maplibre-gl-js-docs/style-spec/#paint-line-line-pattern).
     *
     * @param id The ID of the image.
     * @param image The image as an `HTMLImageElement`, `ImageData`, `ImageBitmap` or object with `width`, `height`, and `data`
     * properties with the same format as `ImageData`.
     *
     * @example
     * // If an image with the ID 'cat' already exists in the style's sprite,
     * // replace that image with a new image, 'other-cat-icon.png'.
     * if (map.hasImage('cat')) map.updateImage('cat', './other-cat-icon.png');
     */
    updateImage(id: string,
        image: HTMLImageElement | ImageBitmap | ImageData | {
            width: number;
            height: number;
            data: Uint8Array | Uint8ClampedArray;
        } | StyleImageInterface) {

        const existingImage = this.style.getImage(id);
        if (!existingImage) {
            return this.fire(new ErrorEvent(new Error(
                'The map has no image with that id. If you are adding a new image use `map.addImage(...)` instead.')));
        }
        const imageData = (image instanceof HTMLImageElement || isImageBitmap(image)) ?
            browser.getImageData(image) :
            image;
        const {width, height, data} = imageData;

        if (width === undefined || height === undefined) {
            return this.fire(new ErrorEvent(new Error(
                'Invalid arguments to map.updateImage(). The second argument must be an `HTMLImageElement`, `ImageData`, `ImageBitmap`, ' +
                'or object with `width`, `height`, and `data` properties with the same format as `ImageData`')));
        }

        if (width !== existingImage.data.width || height !== existingImage.data.height) {
            return this.fire(new ErrorEvent(new Error(
                'The width and height of the updated image must be that same as the previous version of the image')));
        }

        const copy = !(image instanceof HTMLImageElement || isImageBitmap(image));
        existingImage.data.replace(data, copy);

        this.style.updateImage(id, existingImage);
    }

    /**
     * Check whether or not an image with a specific ID exists in the style. This checks both images
     * in the style's original sprite and any images
     * that have been added at runtime using {@link Map#addImage}.
     *
     * @param id The ID of the image.
     *
     * @returns {boolean} A Boolean indicating whether the image exists.
     * @example
     * // Check if an image with the ID 'cat' exists in
     * // the style's sprite.
     * var catIconExists = map.hasImage('cat');
     */
    hasImage(id: string): boolean {
        if (!id) {
            this.fire(new ErrorEvent(new Error('Missing required image id')));
            return false;
        }

        return !!this.style.getImage(id);
    }

    /**
     * Remove an image from a style. This can be an image from the style's original
     * sprite or any images
     * that have been added at runtime using {@link Map#addImage}.
     *
     * @param id The ID of the image.
     *
     * @example
     * // If an image with the ID 'cat' exists in
     * // the style's sprite, remove it.
     * if (map.hasImage('cat')) map.removeImage('cat');
     */
    removeImage(id: string) {
        this.style.removeImage(id);
    }

    /**
     * Load an image from an external URL to be used with {@link Map#addImage}. External
     * domains must support [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Access_control_CORS).
     *
     * @param {string} url The URL of the image file. Image file must be in png, webp, or jpg format.
     * @param {Callback<HTMLImageElement | ImageBitmap>} callback Expecting `callback(error, data)`. Called when the image has loaded or with an error argument if there is an error.
     *
     * @example
     * // Load an image from an external URL.
     * map.loadImage('http://placekitten.com/50/50', function(error, image) {
     *   if (error) throw error;
     *   // Add the loaded image to the style's sprite with the ID 'kitten'.
     *   map.addImage('kitten', image);
     * });
     *
     * @see [Add an icon to the map](https://maplibre.org/maplibre-gl-js-docs/example/add-image/)
     */
    loadImage(url: string, callback: GetImageCallback) {
        getImage(this._requestManager.transformRequest(url, ResourceType.Image), callback);
    }

    /**
     * Returns an Array of strings containing the IDs of all images currently available in the map.
     * This includes both images from the style's original sprite
     * and any images that have been added at runtime using {@link Map#addImage}.
     *
     * @returns {Array<string>} An Array of strings containing the names of all sprites/images currently available in the map.
     *
     * @example
     * var allImages = map.listImages();
     *
     */
    listImages() {
        return this.style.listImages();
    }

    /**
     * Adds a [MapLibre style layer](https://maplibre.org/maplibre-gl-js-docs/style-spec/#layers)
     * to the map's style.
     *
     * A layer defines how data from a specified source will be styled. Read more about layer types
     * and available paint and layout properties in the [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/#layers).
     *
     * TODO: JSDoc can't pass @param {(LayerSpecification & {source?: string | SourceSpecification}) | CustomLayerInterface} layer The layer to add,
     * @param {Object} layer
     * conforming to either the MapLibre Style Specification's [layer definition](https://maplibre.org/maplibre-gl-js-docs/style-spec/#layers) or,
     * less commonly, the {@link CustomLayerInterface} specification.
     * The MapLibre Style Specification's layer definition is appropriate for most layers.
     *
     * @param {string} layer.id A unique identifer that you define.
     * @param {string} layer.type The type of layer (for example `fill` or `symbol`).
     * A list of layer types is available in the [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/layers/#type).
     *
     * (This can also be `custom`. For more information, see {@link CustomLayerInterface}.)
     * @param {string | SourceSpecification} [layer.source] The data source for the layer.
     * Reference a source that has _already been defined_ using the source's unique id.
     * Reference a _new source_ using a source object (as defined in the [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/sources/)) directly.
     * This is **required** for all `layer.type` options _except_ for `custom` and `background`.
     * @param {string} [layer.sourceLayer] (optional) The name of the source layer within the specified `layer.source` to use for this style layer.
     * This is only applicable for vector tile sources and is **required** when `layer.source` is of the type `vector`.
     * @param {array} [layer.filter] (optional) An expression specifying conditions on source features.
     * Only features that match the filter are displayed.
     * The MapLibre Style Specification includes more information on the limitations of the [`filter`](https://maplibre.org/maplibre-gl-js-docs/style-spec/layers/#filter) parameter
     * and a complete list of available [expressions](https://maplibre.org/maplibre-gl-js-docs/style-spec/expressions/).
     * If no filter is provided, all features in the source (or source layer for vector tilesets) will be displayed.
     * @param {Object} [layer.paint] (optional) Paint properties for the layer.
     * Available paint properties vary by `layer.type`.
     * A full list of paint properties for each layer type is available in the [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/layers/).
     * If no paint properties are specified, default values will be used.
     * @param {Object} [layer.layout] (optional) Layout properties for the layer.
     * Available layout properties vary by `layer.type`.
     * A full list of layout properties for each layer type is available in the [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/layers/).
     * If no layout properties are specified, default values will be used.
     * @param {number} [layer.maxzoom] (optional) The maximum zoom level for the layer.
     * At zoom levels equal to or greater than the maxzoom, the layer will be hidden.
     * The value can be any number between `0` and `24` (inclusive).
     * If no maxzoom is provided, the layer will be visible at all zoom levels for which there are tiles available.
     * @param {number} [layer.minzoom] (optional) The minimum zoom level for the layer.
     * At zoom levels less than the minzoom, the layer will be hidden.
     * The value can be any number between `0` and `24` (inclusive).
     * If no minzoom is provided, the layer will be visible at all zoom levels for which there are tiles available.
     * @param {Object} [layer.metadata] (optional) Arbitrary properties useful to track with the layer, but do not influence rendering.
     * @param {string} [layer.renderingMode] This is only applicable for layers with the type `custom`.
     * See {@link CustomLayerInterface} for more information.
     * @param {string} [beforeId] The ID of an existing layer to insert the new layer before,
     * resulting in the new layer appearing visually beneath the existing layer.
     * If this argument is not specified, the layer will be appended to the end of the layers array
     * and appear visually above all other layers.
     *
     * @returns {Map} `this`
     *
     * @example
     * // Add a circle layer with a vector source
     * map.addLayer({
     *   id: 'points-of-interest',
     *   source: {
     *     type: 'vector',
     *     url: 'https://demotiles.maplibre.org/tiles/tiles.json'
     *   },
     *   'source-layer': 'poi_label',
     *   type: 'circle',
     *   paint: {
     *     // MapLibre Style Specification paint properties
     *   },
     *   layout: {
     *     // MapLibre Style Specification layout properties
     *   }
     * });
     *
     * @example
     * // Define a source before using it to create a new layer
     * map.addSource('state-data', {
     *   type: 'geojson',
     *   data: 'path/to/data.geojson'
     * });
     *
     * map.addLayer({
     *   id: 'states',
     *   // References the GeoJSON source defined above
     *   // and does not require a `source-layer`
     *   source: 'state-data',
     *   type: 'symbol',
     *   layout: {
     *     // Set the label content to the
     *     // feature's `name` property
     *     text-field: ['get', 'name']
     *   }
     * });
     *
     * @example
     * // Add a new symbol layer before an existing layer
     * map.addLayer({
     *   id: 'states',
     *   // References a source that's already been defined
     *   source: 'state-data',
     *   type: 'symbol',
     *   layout: {
     *     // Set the label content to the
     *     // feature's `name` property
     *     text-field: ['get', 'name']
     *   }
     * // Add the layer before the existing `cities` layer
     * }, 'cities');
     *
     * @see [Create and style clusters](https://maplibre.org/maplibre-gl-js-docs/example/cluster/)
     * @see [Add a vector tile source](https://maplibre.org/maplibre-gl-js-docs/example/vector-source/)
     * @see [Add a WMS source](https://maplibre.org/maplibre-gl-js-docs/example/wms/)
     */
    addLayer(layer: (LayerSpecification & {source?: string | SourceSpecification}) | CustomLayerInterface, beforeId?: string) {
        this._lazyInitEmptyStyle();
        this.style.addLayer(layer, beforeId);
        return this._update(true);
    }

    /**
     * Moves a layer to a different z-position.
     *
     * @param {string} id The ID of the layer to move.
     * @param {string} [beforeId] The ID of an existing layer to insert the new layer before. When viewing the map, the `id` layer will appear beneath the `beforeId` layer. If `beforeId` is omitted, the layer will be appended to the end of the layers array and appear above all other layers on the map.
     * @returns {Map} `this`
     *
     * @example
     * // Move a layer with ID 'polygon' before the layer with ID 'country-label'. The `polygon` layer will appear beneath the `country-label` layer on the map.
     * map.moveLayer('polygon', 'country-label');
     */
    moveLayer(id: string, beforeId?: string) {
        this.style.moveLayer(id, beforeId);
        return this._update(true);
    }

    // eslint-disable-next-line jsdoc/require-returns
    /**
     * Removes the layer with the given ID from the map's style.
     *
     * If no such layer exists, an `error` event is fired.
     *
     * @param {string} id id of the layer to remove
     * @fires error
     *
     * @example
     * // If a layer with ID 'state-data' exists, remove it.
     * if (map.getLayer('state-data')) map.removeLayer('state-data');
     */
    removeLayer(id: string) {
        this.style.removeLayer(id);
        return this._update(true);
    }

    /**
     * Returns the layer with the specified ID in the map's style.
     *
     * @param {string} id The ID of the layer to get.
     * @returns {StyleLayer} The layer with the specified ID, or `undefined`
     *   if the ID corresponds to no existing layers.
     *
     * @example
     * var stateDataLayer = map.getLayer('state-data');
     *
     * @see [Filter symbols by toggling a list](https://maplibre.org/maplibre-gl-js-docs/example/filter-markers/)
     * @see [Filter symbols by text input](https://maplibre.org/maplibre-gl-js-docs/example/filter-markers-by-input/)
     */
    getLayer(id: string): StyleLayer {
        return this.style.getLayer(id);
    }

    /**
     * Sets the zoom extent for the specified style layer. The zoom extent includes the
     * [minimum zoom level](https://maplibre.org/maplibre-gl-js-docs/style-spec/#layer-minzoom)
     * and [maximum zoom level](https://maplibre.org/maplibre-gl-js-docs/style-spec/#layer-maxzoom))
     * at which the layer will be rendered.
     *
     * Note: For style layers using vector sources, style layers cannot be rendered at zoom levels lower than the
     * minimum zoom level of the _source layer_ because the data does not exist at those zoom levels. If the minimum
     * zoom level of the source layer is higher than the minimum zoom level defined in the style layer, the style
     * layer will not be rendered at all zoom levels in the zoom range.
     *
     * @param {string} layerId The ID of the layer to which the zoom extent will be applied.
     * @param {number} minzoom The minimum zoom to set (0-24).
     * @param {number} maxzoom The maximum zoom to set (0-24).
     * @returns {Map} `this`
     *
     * @example
     * map.setLayerZoomRange('my-layer', 2, 5);
     *
     */
    setLayerZoomRange(layerId: string, minzoom: number, maxzoom: number) {
        this.style.setLayerZoomRange(layerId, minzoom, maxzoom);
        return this._update(true);
    }

    /**
     * Sets the filter for the specified style layer.
     *
     * Filters control which features a style layer renders from its source.
     * Any feature for which the filter expression evaluates to `true` will be
     * rendered on the map. Those that are false will be hidden.
     *
     * Use `setFilter` to show a subset of your source data.
     *
     * To clear the filter, pass `null` or `undefined` as the second parameter.
     *
     * @param {string} layerId The ID of the layer to which the filter will be applied.
     * @param {Array | null | undefined} filter The filter, conforming to the MapLibre Style Specification's
     *   [filter definition](https://maplibre.org/maplibre-gl-js-docs/style-spec/layers/#filter).  If `null` or `undefined` is provided, the function removes any existing filter from the layer.
     * @param {Object} [options] Options object.
     * @param {boolean} [options.validate=true] Whether to check if the filter conforms to the MapLibre GL Style Specification. Disabling validation is a performance optimization that should only be used if you have previously validated the values you will be passing to this function.
     * @returns {Map} `this`
     *
     * @example
     * // display only features with the 'name' property 'USA'
     * map.setFilter('my-layer', ['==', ['get', 'name'], 'USA']);
     * @example
     * // display only features with five or more 'available-spots'
     * map.setFilter('bike-docks', ['>=', ['get', 'available-spots'], 5]);
     * @example
     * // remove the filter for the 'bike-docks' style layer
     * map.setFilter('bike-docks', null);
     *
     * @see [Create a timeline animation](https://maplibre.org/maplibre-gl-js-docs/example/timeline-animation/)
     */
    setFilter(layerId: string, filter?: FilterSpecification | null,  options: StyleSetterOptions = {}) {
        this.style.setFilter(layerId, filter, options);
        return this._update(true);
    }

    /**
     * Returns the filter applied to the specified style layer.
     *
     * @param {string} layerId The ID of the style layer whose filter to get.
     * @returns {Array} The layer's filter.
     */
    getFilter(layerId: string) {
        return this.style.getFilter(layerId);
    }

    /**
     * Sets the value of a paint property in the specified style layer.
     *
     * @param {string} layerId The ID of the layer to set the paint property in.
     * @param {string} name The name of the paint property to set.
     * @param {*} value The value of the paint property to set.
     *   Must be of a type appropriate for the property, as defined in the [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/).
     * @param {Object} [options] Options object.
     * @param {boolean} [options.validate=true] Whether to check if `value` conforms to the MapLibre GL Style Specification. Disabling validation is a performance optimization that should only be used if you have previously validated the values you will be passing to this function.
     * @returns {Map} `this`
     * @example
     * map.setPaintProperty('my-layer', 'fill-color', '#faafee');
     * @see [Change a layer's color with buttons](https://maplibre.org/maplibre-gl-js-docs/example/color-switcher/)
     * @see [Create a draggable point](https://maplibre.org/maplibre-gl-js-docs/example/drag-a-point/)
     */
    setPaintProperty(layerId: string, name: string, value: any, options: StyleSetterOptions = {}) {
        this.style.setPaintProperty(layerId, name, value, options);
        return this._update(true);
    }

    /**
     * Returns the value of a paint property in the specified style layer.
     *
     * @param {string} layerId The ID of the layer to get the paint property from.
     * @param {string} name The name of a paint property to get.
     * @returns {*} The value of the specified paint property.
     */
    getPaintProperty(layerId: string, name: string) {
        return this.style.getPaintProperty(layerId, name);
    }

    /**
     * Sets the value of a layout property in the specified style layer.
     *
     * @param {string} layerId The ID of the layer to set the layout property in.
     * @param {string} name The name of the layout property to set.
     * @param {*} value The value of the layout property. Must be of a type appropriate for the property, as defined in the [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/).
     * @param {Object} [options] Options object.
     * @param {boolean} [options.validate=true] Whether to check if `value` conforms to the MapLibre GL Style Specification. Disabling validation is a performance optimization that should only be used if you have previously validated the values you will be passing to this function.
     * @returns {Map} `this`
     * @example
     * map.setLayoutProperty('my-layer', 'visibility', 'none');
     */
    setLayoutProperty(layerId: string, name: string, value: any, options: StyleSetterOptions = {}) {
        this.style.setLayoutProperty(layerId, name, value, options);
        return this._update(true);
    }

    /**
     * Returns the value of a layout property in the specified style layer.
     *
     * @param {string} layerId The ID of the layer to get the layout property from.
     * @param {string} name The name of the layout property to get.
     * @returns {*} The value of the specified layout property.
     */
    getLayoutProperty(layerId: string, name: string) {
        return this.style.getLayoutProperty(layerId, name);
    }

    /**
     * Sets the any combination of light values.
     *
     * @param light Light properties to set. Must conform to the [MapLibre Style Specification](https://maplibre.org/maplibre-gl-js-docs/style-spec/#light).
     * @param {Object} [options] Options object.
     * @param {boolean} [options.validate=true] Whether to check if the filter conforms to the MapLibre GL Style Specification. Disabling validation is a performance optimization that should only be used if you have previously validated the values you will be passing to this function.
     * @returns {Map} `this`
     * @example
     * var layerVisibility = map.getLayoutProperty('my-layer', 'visibility');
     */
    setLight(light: LightSpecification, options: StyleSetterOptions = {}) {
        this._lazyInitEmptyStyle();
        this.style.setLight(light, options);
        return this._update(true);
    }

    /**
     * Returns the value of the light object.
     *
     * @returns {Object} light Light properties of the style.
     */
    getLight() {
        return this.style.getLight();
    }

    // eslint-disable-next-line jsdoc/require-returns
    /**
     * Sets the `state` of a feature.
     * A feature's `state` is a set of user-defined key-value pairs that are assigned to a feature at runtime.
     * When using this method, the `state` object is merged with any existing key-value pairs in the feature's state.
     * Features are identified by their `feature.id` attribute, which can be any number or string.
     *
     * This method can only be used with sources that have a `feature.id` attribute. The `feature.id` attribute can be defined in three ways:
     * - For vector or GeoJSON sources, including an `id` attribute in the original data file.
     * - For vector or GeoJSON sources, using the [`promoteId`](https://maplibre.org/maplibre-gl-js-docs/style-spec/sources/#vector-promoteId) option at the time the source is defined.
     * - For GeoJSON sources, using the [`generateId`](https://maplibre.org/maplibre-gl-js-docs/style-spec/sources/#geojson-generateId) option to auto-assign an `id` based on the feature's index in the source data. If you change feature data using `map.getSource('some id').setData(..)`, you may need to re-apply state taking into account updated `id` values.
     *
     * _Note: You can use the [`feature-state` expression](https://maplibre.org/maplibre-gl-js-docs/style-spec/expressions/#feature-state) to access the values in a feature's state object for the purposes of styling._
     *
     * @param {Object} feature Feature identifier. Feature objects returned from
     * {@link Map#queryRenderedFeatures} or event handlers can be used as feature identifiers.
     * @param {string | number} feature.id Unique id of the feature.
     * @param {string} feature.source The id of the vector or GeoJSON source for the feature.
     * @param {string} [feature.sourceLayer] (optional) *For vector tile sources, `sourceLayer` is required.*
     * @param {Object} state A set of key-value pairs. The values should be valid JSON types.
     *
     * @example
     * // When the mouse moves over the `my-layer` layer, update
     * // the feature state for the feature under the mouse
     * map.on('mousemove', 'my-layer', function(e) {
     *   if (e.features.length > 0) {
     *     map.setFeatureState({
     *       source: 'my-source',
     *       sourceLayer: 'my-source-layer',
     *       id: e.features[0].id,
     *     }, {
     *       hover: true
     *     });
     *   }
     * });
     *
     * @see [Create a hover effect](https://maplibre.org/maplibre-gl-js-docs/example/hover-styles/)
     */
    setFeatureState(feature: FeatureIdentifier, state: any) {
        this.style.setFeatureState(feature, state);
        return this._update();
    }

    // eslint-disable-next-line jsdoc/require-returns
    /**
     * Removes the `state` of a feature, setting it back to the default behavior.
     * If only a `target.source` is specified, it will remove the state for all features from that source.
     * If `target.id` is also specified, it will remove all keys for that feature's state.
     * If `key` is also specified, it removes only that key from that feature's state.
     * Features are identified by their `feature.id` attribute, which can be any number or string.
     *
     * @param {Object} target Identifier of where to remove state. It can be a source, a feature, or a specific key of feature.
     * Feature objects returned from {@link Map#queryRenderedFeatures} or event handlers can be used as feature identifiers.
     * @param {string | number} target.id (optional) Unique id of the feature. Optional if key is not specified.
     * @param {string} target.source The id of the vector or GeoJSON source for the feature.
     * @param {string} [target.sourceLayer] (optional) *For vector tile sources, `sourceLayer` is required.*
     * @param {string} key (optional) The key in the feature state to reset.
     *
     * @example
     * // Reset the entire state object for all features
     * // in the `my-source` source
     * map.removeFeatureState({
     *   source: 'my-source'
     * });
     *
     * @example
     * // When the mouse leaves the `my-layer` layer,
     * // reset the entire state object for the
     * // feature under the mouse
     * map.on('mouseleave', 'my-layer', function(e) {
     *   map.removeFeatureState({
     *     source: 'my-source',
     *     sourceLayer: 'my-source-layer',
     *     id: e.features[0].id
     *   });
     * });
     *
     * @example
     * // When the mouse leaves the `my-layer` layer,
     * // reset only the `hover` key-value pair in the
     * // state for the feature under the mouse
     * map.on('mouseleave', 'my-layer', function(e) {
     *   map.removeFeatureState({
     *     source: 'my-source',
     *     sourceLayer: 'my-source-layer',
     *     id: e.features[0].id
     *   }, 'hover');
     * });
     *
     */
    removeFeatureState(target: FeatureIdentifier, key?: string) {
        this.style.removeFeatureState(target, key);
        return this._update();
    }

    /**
     * Gets the `state` of a feature.
     * A feature's `state` is a set of user-defined key-value pairs that are assigned to a feature at runtime.
     * Features are identified by their `feature.id` attribute, which can be any number or string.
     *
     * _Note: To access the values in a feature's state object for the purposes of styling the feature, use the [`feature-state` expression](https://maplibre.org/maplibre-gl-js-docs/style-spec/expressions/#feature-state)._
     *
     * @param {Object} feature Feature identifier. Feature objects returned from
     * {@link Map#queryRenderedFeatures} or event handlers can be used as feature identifiers.
     * @param {string | number} feature.id Unique id of the feature.
     * @param {string} feature.source The id of the vector or GeoJSON source for the feature.
     * @param {string} [feature.sourceLayer] (optional) *For vector tile sources, `sourceLayer` is required.*
     *
     * @returns {Object} The state of the feature: a set of key-value pairs that was assigned to the feature at runtime.
     *
     * @example
     * // When the mouse moves over the `my-layer` layer,
     * // get the feature state for the feature under the mouse
     * map.on('mousemove', 'my-layer', function(e) {
     *   if (e.features.length > 0) {
     *     map.getFeatureState({
     *       source: 'my-source',
     *       sourceLayer: 'my-source-layer',
     *       id: e.features[0].id
     *     });
     *   }
     * });
     *
     */
    getFeatureState(feature: FeatureIdentifier): any {
        return this.style.getFeatureState(feature);
    }

    /**
     * Returns the map's containing HTML element.
     *
     * @returns {HTMLElement} The map's container.
     */
    getContainer() {
        return this._container;
    }

    /**
     * Returns the HTML element containing the map's `<canvas>` element.
     *
     * If you want to add non-GL overlays to the map, you should append them to this element.
     *
     * This is the element to which event bindings for map interactivity (such as panning and zooming) are
     * attached. It will receive bubbled events from child elements such as the `<canvas>`, but not from
     * map controls.
     *
     * @returns {HTMLElement} The container of the map's `<canvas>`.
     * @see [Create a draggable point](https://maplibre.org/maplibre-gl-js-docs/example/drag-a-point/)
     */
    getCanvasContainer() {
        return this._canvasContainer;
    }

    /**
     * Returns the map's `<canvas>` element.
     *
     * @returns {HTMLCanvasElement} The map's `<canvas>` element.
     * @see [Measure distances](https://maplibre.org/maplibre-gl-js-docs/example/measure/)
     * @see [Display a popup on hover](https://maplibre.org/maplibre-gl-js-docs/example/popup-on-hover/)
     * @see [Center the map on a clicked symbol](https://maplibre.org/maplibre-gl-js-docs/example/center-on-symbol/)
     */
    getCanvas() {
        return this._canvas;
    }

    _containerDimensions() {
        let width = 0;
        let height = 0;

        if (this._container) {
            width = this._container.clientWidth || 400;
            height = this._container.clientHeight || 300;
        }

        return [width, height];
    }

    _setupContainer() {
        const container = this._container;
        container.classList.add('maplibregl-map', 'mapboxgl-map');

        const canvasContainer = this._canvasContainer = DOM.create('div', 'maplibregl-canvas-container mapboxgl-canvas-container', container);
        if (this._interactive) {
            canvasContainer.classList.add('maplibregl-interactive', 'mapboxgl-interactive');
        }

        this._canvas = DOM.create('canvas', 'maplibregl-canvas mapboxgl-canvas', canvasContainer);
        this._canvas.addEventListener('webglcontextlost', this._contextLost, false);
        this._canvas.addEventListener('webglcontextrestored', this._contextRestored, false);
        this._canvas.setAttribute('tabindex', '0');
        this._canvas.setAttribute('aria-label', 'Map');
        this._canvas.setAttribute('role', 'region');

        const dimensions = this._containerDimensions();
        this._resizeCanvas(dimensions[0], dimensions[1], this.getPixelRatio());

        const controlContainer = this._controlContainer = DOM.create('div', 'maplibregl-control-container mapboxgl-control-container', container);
        const positions = this._controlPositions = {};
        ['top-left', 'top-right', 'bottom-left', 'bottom-right'].forEach((positionName) => {
            positions[positionName] = DOM.create('div', `maplibregl-ctrl-${positionName} mapboxgl-ctrl-${positionName}`, controlContainer);
        });

        this._container.addEventListener('scroll', this._onMapScroll, false);
    }

    _setupCooperativeGestures() {
        const container = this._container;
        this._metaPress = false;
        this._cooperativeGesturesScreen = DOM.create('div', 'maplibregl-cooperative-gesture-screen', container);
        let modifierKeyName = 'Control';
        let desktopMessage = typeof this._cooperativeGestures !== 'boolean' && this._cooperativeGestures.windowsHelpText ? this._cooperativeGestures.windowsHelpText : 'Use Ctrl + scroll to zoom the map';
        if (navigator.platform.indexOf('Mac') === 0) {
            desktopMessage = typeof this._cooperativeGestures !== 'boolean' && this._cooperativeGestures.macHelpText ? this._cooperativeGestures.macHelpText : 'Use ⌘ + scroll to zoom the map';
            modifierKeyName = 'Meta';
        }
        const mobileMessage = typeof this._cooperativeGestures !== 'boolean' && this._cooperativeGestures.mobileHelpText ? this._cooperativeGestures.mobileHelpText : 'Use two fingers to move the map';
        this._cooperativeGesturesScreen.innerHTML = `
            <div class="maplibregl-desktop-message">${desktopMessage}</div>
            <div class="maplibregl-mobile-message">${mobileMessage}</div>
        `;
        document.addEventListener('keydown', (event) => {
            if (event.key === modifierKeyName) this._metaPress = true;
        });
        document.addEventListener('keyup', (event) => {
            if (event.key === modifierKeyName) this._metaPress = false;
        });
        // Add event to canvas container since gesture container is pointer-events: none
        this._canvasContainer.addEventListener('wheel', (e) => {
            this._onCooperativeGesture(e, this._metaPress, 1);
        }, false);
        // Remove the traditional pan classes
        this._canvasContainer.classList.remove('mapboxgl-touch-drag-pan', 'maplibregl-touch-drag-pan');
    }

    _resizeCanvas(width: number, height: number, pixelRatio: number) {
        // Request the required canvas size taking the pixelratio into account.
        this._canvas.width = pixelRatio * width;
        this._canvas.height = pixelRatio * height;

        // Maintain the same canvas size, potentially downscaling it for HiDPI displays
        this._canvas.style.width = `${width}px`;
        this._canvas.style.height = `${height}px`;
    }

    _setupPainter() {
        const attributes = extend({}, supported.webGLContextAttributes, {
            failIfMajorPerformanceCaveat: this._failIfMajorPerformanceCaveat,
            preserveDrawingBuffer: this._preserveDrawingBuffer,
            antialias: this._antialias || false
        });

        const gl = this._canvas.getContext('webgl', attributes) ||
            this._canvas.getContext('experimental-webgl', attributes);

        if (!gl) {
            this.fire(new ErrorEvent(new Error('Failed to initialize WebGL')));
            return;
        }

        this.painter = new Painter(gl as WebGLRenderingContext, this.transform);

        webpSupported.testSupport(gl as WebGLRenderingContext);
    }

    _contextLost(event: any) {
        event.preventDefault();
        if (this._frame) {
            this._frame.cancel();
            this._frame = null;
        }
        this.fire(new Event('webglcontextlost', {originalEvent: event}));
    }

    _contextRestored(event: any) {
        this._setupPainter();
        this.resize();
        this._update();
        this.fire(new Event('webglcontextrestored', {originalEvent: event}));
    }

    _onMapScroll(event: any) {
        if (event.target !== this._container) return;

        // Revert any scroll which would move the canvas outside of the view
        this._container.scrollTop = 0;
        this._container.scrollLeft = 0;
        return false;
    }

    _onCooperativeGesture(event: any, metaPress, touches) {
        if (!metaPress && touches < 2) {
            // Alert user how to scroll/pan
            this._cooperativeGesturesScreen.classList.add('maplibregl-show');
            setTimeout(() => {
                this._cooperativeGesturesScreen.classList.remove('maplibregl-show');
            }, 100);
        }
        return false;
    }

    /**
     * Returns a Boolean indicating whether the map is fully loaded.
     *
     * Returns `false` if the style is not yet fully loaded,
     * or if there has been a change to the sources or style that
     * has not yet fully loaded.
     *
     * @returns {boolean} A Boolean indicating whether the map is fully loaded.
     */
    loaded() {
        return !this._styleDirty && !this._sourcesDirty && !!this.style && this.style.loaded();
    }

    /**
     * Update this map's style and sources, and re-render the map.
     *
     * @param {boolean} updateStyle mark the map's style for reprocessing as
     * well as its sources
     * @returns {Map} this
     * @private
     */
    _update(updateStyle?: boolean) {
        if (!this.style) return this;

        this._styleDirty = this._styleDirty || updateStyle;
        this._sourcesDirty = true;
        this.triggerRepaint();

        return this;
    }

    /**
     * Request that the given callback be executed during the next render
     * frame.  Schedule a render frame if one is not already scheduled.
     * @returns An id that can be used to cancel the callback
     * @private
     */
    _requestRenderFrame(callback: () => void): TaskID {
        this._update();
        return this._renderTaskQueue.add(callback);
    }

    _cancelRenderFrame(id: TaskID) {
        this._renderTaskQueue.remove(id);
    }

    /**
     * Call when a (re-)render of the map is required:
     * - The style has changed (`setPaintProperty()`, etc.)
     * - Source data has changed (e.g. tiles have finished loading)
     * - The map has is moving (or just finished moving)
     * - A transition is in progress
     *
     * @param {number} paintStartTimeStamp  The time when the animation frame began executing.
     *
     * @returns {Map} this
     * @private
     */
    _render(paintStartTimeStamp: number) {
        let gpuTimer, frameStartTime = 0;
        const extTimerQuery = this.painter.context.extTimerQuery;
        if (this.listens('gpu-timing-frame')) {
            gpuTimer = extTimerQuery.createQueryEXT();
            extTimerQuery.beginQueryEXT(extTimerQuery.TIME_ELAPSED_EXT, gpuTimer);
            frameStartTime = browser.now();
        }

        // A custom layer may have used the context asynchronously. Mark the state as dirty.
        this.painter.context.setDirty();
        this.painter.setBaseState();

        this._renderTaskQueue.run(paintStartTimeStamp);
        // A task queue callback may have fired a user event which may have removed the map
        if (this._removed) return;

        let crossFading = false;

        // If the style has changed, the map is being zoomed, or a transition or fade is in progress:
        //  - Apply style changes (in a batch)
        //  - Recalculate paint properties.
        if (this.style && this._styleDirty) {
            this._styleDirty = false;

            const zoom = this.transform.zoom;
            const now = browser.now();
            this.style.zoomHistory.update(zoom, now);

            const parameters = new EvaluationParameters(zoom, {
                now,
                fadeDuration: this._fadeDuration,
                zoomHistory: this.style.zoomHistory,
                transition: this.style.getTransition()
            });

            const factor = parameters.crossFadingFactor();
            if (factor !== 1 || factor !== this._crossFadingFactor) {
                crossFading = true;
                this._crossFadingFactor = factor;
            }

            this.style.update(parameters);
        }

        // If we are in _render for any reason other than an in-progress paint
        // transition, update source caches to check for and load any tiles we
        // need for the current transform
        if (this.style && this._sourcesDirty) {
            this._sourcesDirty = false;
            this.style._updateSources(this.transform);
        }

        // update terrain stuff
        if (this.style.terrain) this.style.terrain.sourceCache.update(this.transform, this.style.terrain);
        this.transform.updateElevation(this.style.terrain);

        this._placementDirty = this.style && this.style._updatePlacement(this.painter.transform, this.showCollisionBoxes, this._fadeDuration, this._crossSourceCollisions);

        // Actually draw
        this.painter.render(this.style, {
            showTileBoundaries: this.showTileBoundaries,
            showOverdrawInspector: this._showOverdrawInspector,
            rotating: this.isRotating(),
            zooming: this.isZooming(),
            moving: this.isMoving(),
            fadeDuration: this._fadeDuration,
            showPadding: this.showPadding,
            gpuTiming: !!this.listens('gpu-timing-layer'),
        });

        this.fire(new Event('render'));

        if (this.loaded() && !this._loaded) {
            this._loaded = true;
            PerformanceUtils.mark(PerformanceMarkers.load);
            this.fire(new Event('load'));
        }

        if (this.style && (this.style.hasTransitions() || crossFading)) {
            this._styleDirty = true;
        }

        if (this.style && !this._placementDirty) {
            // Since no fade operations are in progress, we can release
            // all tiles held for fading. If we didn't do this, the tiles
            // would just sit in the SourceCaches until the next render
            this.style._releaseSymbolFadeTiles();
        }

        if (this.listens('gpu-timing-frame')) {
            const renderCPUTime = browser.now() - frameStartTime;
            extTimerQuery.endQueryEXT(extTimerQuery.TIME_ELAPSED_EXT, gpuTimer);
            setTimeout(() => {
                const renderGPUTime = extTimerQuery.getQueryObjectEXT(gpuTimer, extTimerQuery.QUERY_RESULT_EXT) / (1000 * 1000);
                extTimerQuery.deleteQueryEXT(gpuTimer);
                this.fire(new Event('gpu-timing-frame', {
                    cpuTime: renderCPUTime,
                    gpuTime: renderGPUTime
                }));
            }, 50); // Wait 50ms to give time for all GPU calls to finish before querying
        }

        if (this.listens('gpu-timing-layer')) {
            // Resetting the Painter's per-layer timing queries here allows us to isolate
            // the queries to individual frames.
            const frameLayerQueries = this.painter.collectGpuTimers();

            setTimeout(() => {
                const renderedLayerTimes = this.painter.queryGpuTimers(frameLayerQueries);

                this.fire(new Event('gpu-timing-layer', {
                    layerTimes: renderedLayerTimes
                }));
            }, 50); // Wait 50ms to give time for all GPU calls to finish before querying
        }

        // Schedule another render frame if it's needed.
        //
        // Even though `_styleDirty` and `_sourcesDirty` are reset in this
        // method, synchronous events fired during Style#update or
        // Style#_updateSources could have caused them to be set again.
        const somethingDirty = this._sourcesDirty || this._styleDirty || this._placementDirty;
        if (somethingDirty || this._repaint) {
            this.triggerRepaint();
        } else if (!this.isMoving() && this.loaded()) {
            this.fire(new Event('idle'));
        }

        if (this._loaded && !this._fullyLoaded && !somethingDirty) {
            this._fullyLoaded = true;
            PerformanceUtils.mark(PerformanceMarkers.fullLoad);
        }

        return this;
    }

    /**
     * Force a synchronous redraw of the map.
     * @example
     * map.redraw();
     * @returns {Map} `this`
     */
    redraw(): Map {
        if (this.style) {
            // cancel the scheduled update
            if (this._frame) {
                this._frame.cancel();
                this._frame = null;
            }
            this._render(0);
        }
        return this;
    }

    /**
     * Clean up and release all internal resources associated with this map.
     *
     * This includes DOM elements, event bindings, web workers, and WebGL resources.
     *
     * Use this method when you are done using the map and wish to ensure that it no
     * longer consumes browser resources. Afterwards, you must not call any other
     * methods on the map.
     */
    remove() {
        if (this._hash) this._hash.remove();

        for (const control of this._controls) control.onRemove(this);
        this._controls = [];

        if (this._frame) {
            this._frame.cancel();
            this._frame = null;
        }
        this._renderTaskQueue.clear();
        this.painter.destroy();
        this.handlers.destroy();
        delete this.handlers;
        this.setStyle(null);
        if (typeof window !== 'undefined') {
            removeEventListener('resize', this._onWindowResize, false);
            removeEventListener('orientationchange', this._onWindowResize, false);
            removeEventListener('online', this._onWindowOnline, false);
        }

        const extension = this.painter.context.gl.getExtension('WEBGL_lose_context');
        if (extension) extension.loseContext();
        this._canvas.removeEventListener('webglcontextrestored', this._contextRestored, false);
        this._canvas.removeEventListener('webglcontextlost', this._contextLost, false);
        DOM.remove(this._canvasContainer);
        DOM.remove(this._controlContainer);
        if (this._cooperativeGestures) {
            DOM.remove(this._cooperativeGesturesScreen);
        }
        this._container.classList.remove('maplibregl-map', 'mapboxgl-map');

        PerformanceUtils.clearMetrics();

        this._removed = true;
        this.fire(new Event('remove'));
    }

    /**
     * Trigger the rendering of a single frame. Use this method with custom layers to
     * repaint the map when the layer changes. Calling this multiple times before the
     * next frame is rendered will still result in only a single frame being rendered.
     * @example
     * map.triggerRepaint();
     * @see [Add a 3D model](https://maplibre.org/maplibre-gl-js-docs/example/add-3d-model/)
     * @see [Add an animated icon to the map](https://maplibre.org/maplibre-gl-js-docs/example/add-image-animated/)
     */
    triggerRepaint() {
        if (this.style && !this._frame) {
            this._frame = browser.frame((paintStartTimeStamp: number) => {
                PerformanceUtils.frame(paintStartTimeStamp);
                this._frame = null;
                this._render(paintStartTimeStamp);
            });
        }
    }

    _onWindowOnline() {
        this._update();
    }

    _onWindowResize(event: Event) {
        if (this._trackResize) {
            this.resize({originalEvent: event})._update();
        }
    }

    /**
     * Gets and sets a Boolean indicating whether the map will render an outline
     * around each tile and the tile ID. These tile boundaries are useful for
     * debugging.
     *
     * The uncompressed file size of the first vector source is drawn in the top left
     * corner of each tile, next to the tile ID.
     *
     * @name showTileBoundaries
     * @type {boolean}
     * @instance
     * @memberof Map
     * @example
     * map.showTileBoundaries = true;
     */
    get showTileBoundaries(): boolean { return !!this._showTileBoundaries; }
    set showTileBoundaries(value: boolean) {
        if (this._showTileBoundaries === value) return;
        this._showTileBoundaries = value;
        this._update();
    }

    /**
     * Gets and sets a Boolean indicating whether the map will visualize
     * the padding offsets.
     *
     * @name showPadding
     * @type {boolean}
     * @instance
     * @memberof Map
     */
    get showPadding(): boolean { return !!this._showPadding; }
    set showPadding(value: boolean) {
        if (this._showPadding === value) return;
        this._showPadding = value;
        this._update();
    }

    /**
     * Gets and sets a Boolean indicating whether the map will render boxes
     * around all symbols in the data source, revealing which symbols
     * were rendered or which were hidden due to collisions.
     * This information is useful for debugging.
     *
     * @name showCollisionBoxes
     * @type {boolean}
     * @instance
     * @memberof Map
     */
    get showCollisionBoxes(): boolean { return !!this._showCollisionBoxes; }
    set showCollisionBoxes(value: boolean) {
        if (this._showCollisionBoxes === value) return;
        this._showCollisionBoxes = value;
        if (value) {
            // When we turn collision boxes on we have to generate them for existing tiles
            // When we turn them off, there's no cost to leaving existing boxes in place
            this.style._generateCollisionBoxes();
        } else {
            // Otherwise, call an update to remove collision boxes
            this._update();
        }
    }

    /*
     * Gets and sets a Boolean indicating whether the map should color-code
     * each fragment to show how many times it has been shaded.
     * White fragments have been shaded 8 or more times.
     * Black fragments have been shaded 0 times.
     * This information is useful for debugging.
     *
     * @name showOverdraw
     * @type {boolean}
     * @instance
     * @memberof Map
     */
    get showOverdrawInspector(): boolean { return !!this._showOverdrawInspector; }
    set showOverdrawInspector(value: boolean) {
        if (this._showOverdrawInspector === value) return;
        this._showOverdrawInspector = value;
        this._update();
    }

    /**
     * Gets and sets a Boolean indicating whether the map will
     * continuously repaint. This information is useful for analyzing performance.
     *
     * @name repaint
     * @type {boolean}
     * @instance
     * @memberof Map
     */
    get repaint(): boolean { return !!this._repaint; }
    set repaint(value: boolean) {
        if (this._repaint !== value) {
            this._repaint = value;
            this.triggerRepaint();
        }
    }
    // show vertices
    get vertices(): boolean { return !!this._vertices; }
    set vertices(value: boolean) { this._vertices = value; this._update(); }

    // for cache browser tests
    _setCacheLimits(limit: number, checkThreshold: number) {
        setCacheLimits(limit, checkThreshold);
    }

    /**
     * Returns the package version of the library
     * @returns {string} Package version of the library
     */
    get version(): string {
        return version;
    }
}

export default Map;
