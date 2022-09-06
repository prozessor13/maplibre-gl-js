import Painter from './painter';
import Tile from '../source/tile';
import Color from '../style-spec/util/color';
import {OverscaledTileID} from '../source/tile_id';
import {drawTerrain} from './draw_terrain';
import type StyleLayer from '../style/style_layer';
import Texture from './texture';
import type Framebuffer from '../gl/framebuffer';
import { forceManyBody } from 'd3';
import { getTextOfJSDocComment } from 'typescript';

/**
 * RenderToTexture
 */
export default class RenderToTexture {
    painter: Painter;
    rttFBOs: Array<Framebuffer>;
    rttTextures: Array<Texture>;
    rttUsedFBOs: Array<boolean>;
    // this object holds a lookup table which layers should rendered to texture
    _renderToTexture: {[keyof in StyleLayer['type']]?: boolean};
    // coordsDescendingInv contains a list of all tiles which should be rendered for one render-to-texture tile
    // e.g. render 4 raster-tiles with size 256px to the 512px render-to-texture tile
    _coordsDescendingInv: {[_: string]: {[_:string]: Array<OverscaledTileID>}};
    // create a string representation of all to tiles rendered to render-to-texture tiles
    // this string representation is used to check if tile should be re-rendered.
    _coordsDescendingInvStr: {[_: string]: {[_:string]: string}};
    // store for render-stacks
    // a render stack is a set of layers which should be rendered into one texture
    // every stylesheet can have multipe stacks. A new stack is created if layers which should
    // not rendered to texture sit inbetween layers which should rendered to texture. e.g. hillshading or symbols
    _stacks: Array<Array<string>>;
    // remember the previous processed layer to check if a new stack is needed
    _prevType: string;
    // a list of tiles that can potentially rendered
    _renderableTiles: Array<Tile>;

    constructor(painter: Painter) {
        this.painter = painter;
        this.rttFBOs = [];
        this.rttTextures = [];
        this._renderToTexture = {background: true, fill: true, line: true, raster: true};
    }

    initialize() {
        const style = this.painter.style;
        const terrain = style.terrain;

        this._stacks = [];
        this._prevType = null;
        this._renderableTiles = terrain.sourceCache.getRenderableTiles();

        // fill _coordsDescendingInv
        this._coordsDescendingInv = {};
        for (const id in style.sourceCaches) {
            this._coordsDescendingInv[id] = {};
            const tileIDs = style.sourceCaches[id].getVisibleCoordinates();
            for (const tileID of tileIDs) {
                const keys = terrain.sourceCache.getTerrainCoords(tileID);
                for (const key in keys) {
                    if (!this._coordsDescendingInv[id][key]) this._coordsDescendingInv[id][key] = [];
                    this._coordsDescendingInv[id][key].push(keys[key]);
                }
            }
        }

        // fill _coordsDescendingInvStr
        this._coordsDescendingInvStr = {};
        for (const id of style._order) {
            const layer = style._layers[id], source = layer.source;
            if (this._renderToTexture[layer.type]) {
                if (!this._coordsDescendingInvStr[source]) {
                    this._coordsDescendingInvStr[source] = {};
                    for (const key in this._coordsDescendingInv[source])
                        this._coordsDescendingInvStr[source][key] = this._coordsDescendingInv[source][key].map(c => c.key).sort().join();
                }
            }
        }

        // check tiles to render
        this.rttUsedFBOs = [];
        this._renderableTiles.forEach(tile => {
            for (const source in this._coordsDescendingInvStr) {
                // rerender if there are more coords to render than in the last rendering
                const coords = this._coordsDescendingInvStr[source][tile.tileID.key];
                if (coords && coords !== tile.rttCoords[source]) tile.rttFBOs = [];
                // rerender if tile is marked for rerender
                if (terrain.needsRerender(source, tile.tileID)) tile.rttFBOs = [];
            }
            // remove framebuffer from reusing, instead reuse texture for current render pass
            for (const i of tile.rttFBOs) this.rttUsedFBOs[i] = true;
        });
        terrain.clearRerenderCache();
        terrain.sourceCache.removeOutdated(this.painter);

        return this;
    }

    getTexture(tile): Texture {
        const stack = this._stacks.length - 1;
        return this.rttTextures[tile.rttFBOs[stack]];
    }

    getFBO(): number {
        // check for free framebuffers
        for (let i=0; i<this.rttFBOs.length; i++) {
            if (!this.rttUsedFBOs[i]) {
                this.rttUsedFBOs[i] = true;
                return i;
            }
        }
        // create new framebuffer
        const context = this.painter.context;
        const terrain = this.painter.style.terrain;
        const size = terrain.sourceCache.tileSize * terrain.qualityFactor;
        const fbo = context.createFramebuffer(size, size, true);
        const texture = new Texture(context, {width: size, height: size, data: null}, context.gl.RGBA);
        texture.bind(context.gl.LINEAR, context.gl.CLAMP_TO_EDGE);
        fbo.depthAttachment.set(context.createRenderbuffer(context.gl.DEPTH_COMPONENT16, size, size));
        fbo.colorAttachment.set(texture.texture);
        this.rttFBOs.push(fbo);
        this.rttTextures.push(texture);
        return this.rttFBOs.length - 1;
    }

    prepareFBO(i: number) {
        const fbo = this.rttFBOs[i];
        this.painter.context.bindFramebuffer.set(fbo.framebuffer);
        this.painter.context.viewport.set([0, 0, fbo.width, fbo.height]);
        this.painter.context.clear({color: Color.transparent});
    }

    freeFBO(i: number) {
        if (typeof(i) === "number") // check for null or undefined values
            this.rttUsedFBOs[i] = false;
    }

    /**
     * due that switching textures is relatively slow, the render
     * layer-by-layer context is not practicable. To bypass this problem
     * this lines of code stack all layers and later render all at once.
     * Because of the stylesheet possibility to mixing render-to-texture layers
     * and 'live'-layers (f.e. symbols) it is necessary to create more stacks. For example
     * a symbol-layer is in between of fill-layers.
     * @param {StyleLayer} layer the layer to render
     * @returns {boolean} if true layer is rendered to texture, otherwise false
     */
    renderLayer(layer: StyleLayer): boolean {
        const type = layer.type;
        const painter = this.painter;
        const layerIds = painter.style._order;
        const currentLayer = painter.currentLayer;
        const isLastLayer = currentLayer + 1 === layerIds.length;

        // remember background, fill, line & raster layer to render into a stack
        if (this._renderToTexture[type]) {
            if (!this._prevType || !this._renderToTexture[this._prevType]) this._stacks.push([]);
            this._prevType = type;
            this._stacks[this._stacks.length - 1].push(layerIds[currentLayer]);
            // rendering is done later, all in once
            if (!isLastLayer) return true;
        }

        // in case a stack is finished render all collected stack-layers into a texture
        if (this._renderToTexture[this._prevType] || type === 'hillshade' || (this._renderToTexture[type] && isLastLayer)) {
            this._prevType = type;
            const stack = this._stacks.length - 1, layers = this._stacks[stack] || [];
            if (this._stacks.length) for (const tile of this._renderableTiles) {
                if (tile.rttFBOs[stack]) continue; // layer is rendered in an previous pass
                tile.rttFBOs[stack] = this.getFBO();
                this.prepareFBO(tile.rttFBOs[stack]);
                for (let l = 0; l < layers.length; l++) {
                    const layer = painter.style._layers[layers[l]];
                    const coords = layer.source ? this._coordsDescendingInv[layer.source][tile.tileID.key] : [tile.tileID];
                    painter._renderTileClippingMasks(layer, coords);
                    painter.renderLayer(painter, painter.style.sourceCaches[layer.source], layer, coords);
                    if (layer.source) tile.rttCoords[layer.source] = this._coordsDescendingInvStr[layer.source][tile.tileID.key];
                }
            }
            drawTerrain(this.painter, this, this._renderableTiles);

            // the hillshading layer is a special case because it changes on every camera-movement
            // so rerender it in any case.
            if (type === 'hillshade') {
                this._stacks.push([layerIds[currentLayer]]);
                const stack = this._stacks.length - 1;
                for (const tile of this._renderableTiles) {
                    this.freeFBO(tile.rttFBOs[stack]);
                    tile.rttFBOs[stack] = this.getFBO();
                    this.prepareFBO(tile.rttFBOs[stack]);
                    const coords = this._coordsDescendingInv[layer.source][tile.tileID.key];
                    painter._renderTileClippingMasks(layer, coords);
                    painter.renderLayer(painter, painter.style.sourceCaches[layer.source], layer, coords);
                }
                drawTerrain(this.painter, this, this._renderableTiles);
                return true;
            }

            return this._renderToTexture[type];
        }

        return false;
    }

}
