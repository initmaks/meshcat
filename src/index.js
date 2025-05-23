var THREE = require('three');
var msgpack = require('msgpack-lite');
var dat = require('dat.gui').default; // TODO: why is .default needed?
import {mergeBufferGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {OBJLoader2, MtlObjBridge} from 'wwobjloader2'
import {ColladaLoader} from 'three/examples/jsm/loaders/ColladaLoader.js';
import {MTLLoader} from 'three/examples/jsm/loaders/MTLLoader.js';
import {STLLoader} from 'three/examples/jsm/loaders/STLLoader.js';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
require('ccapture.js');
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg'; // Restore static import

// Merges a hierarchy of collada mesh geometries into a single
// `BufferGeometry` object:
//   * A new merged `BufferGeometry` if the input contains meshes
//   * empty `BufferGeometry` otherwise
function merge_geometries(object, preserve_materials = false) {
    let materials = [];
    let geometries = [];
    let root_transform = object.matrix.clone();
    function collectGeometries(node, parent_transform) {
        let transform = parent_transform.clone().multiply(node.matrix);
        if (node.type==='Mesh') {
            node.geometry.applyMatrix4(transform);
            geometries.push(node.geometry);
            materials.push(node.material);
        }
        for (let child of node.children) {
            collectGeometries(child, transform);
        }
    }
    collectGeometries(object, root_transform);
    let result = null;
    if (geometries.length == 1) {
        result =  geometries[0];
        if (preserve_materials) {
            result.material = materials[0];
        }
    } else if (geometries.length > 1) {
        result = mergeBufferGeometries(geometries, true);
        if (preserve_materials) {
            result.material = materials;
        }
    } else {
        result = new THREE.BufferGeometry();
    }
    return result;
}

// Handler for special texture types that we want to support
// in addition to whatever three.js supports. This function
// takes a json object representing a single texture, and should
// return either:
//   * A new `THREE.Texture` if that json represents a special texture
//   * `null` otherwise
function handle_special_texture(json) {
    if (json.type == "_text") {
        let canvas = document.createElement('canvas');
        // canvas width and height should be in the power of 2; otherwise although
        // the page usually loads successfully, WebGL does complain/warn
        canvas.width = 256;
        canvas.height = 256;
        let ctx = canvas.getContext('2d');
        ctx.textAlign = "center";
        let font_size = json.font_size;
        // auto-resing the font_size to fit in the canvas
        ctx.font = font_size + "px " + json.font_face;
        while (ctx.measureText(json.text).width > canvas.width) {
            font_size--;
            ctx.font = font_size + "px " + json.font_face;
        }
        ctx.fillText(json.text, canvas.width / 2, canvas.height / 2);
        let canvas_texture = new THREE.CanvasTexture(canvas);
        canvas_texture.uuid = json.uuid;
        return canvas_texture;
    } else {
        return null;
    }
}

// Handler for special geometry types that we want to support
// in addition to whatever three.js supports. This function
// takes a json object representing a single geometry, and should
// return either:
//   * A new `THREE.Mesh` if that json represents a special geometry
//   * `null` otherwise
function handle_special_geometry(geom) {
    if (geom.type == "_meshfile") {
        console.warn("_meshfile is deprecated. Please use _meshfile_geometry for geometries and _meshfile_object for objects with geometry and material");
        geom.type = "_meshfile_geometry";
    }
    if (geom.type == "_meshfile_geometry") {
        if (geom.format == "obj") {
            let loader = new OBJLoader2();
            let obj = loader.parse(geom.data + "\n");
            let loaded_geom = merge_geometries(obj);
            loaded_geom.uuid = geom.uuid;
            return loaded_geom;
        } else if (geom.format == "dae") {
            let loader = new ColladaLoader();
            let obj = loader.parse(geom.data);
            let result = merge_geometries(obj.scene);
            result.uuid = geom.uuid;
            return result;
        } else if (geom.format == "stl") {
            let loader = new STLLoader();
            let loaded_geom = loader.parse(geom.data.buffer);
            loaded_geom.uuid = geom.uuid;
            return loaded_geom;
        } else {
            console.error("Unsupported mesh type:", geom);
            return null;
        }
    }
    return null;
}

// The ExtensibleObjectLoader extends the THREE.ObjectLoader
// interface, while providing some hooks for us to perform some
// custom loading for things other than three.js native JSON.
//
// We currently use this class to support some extensions to
// three.js JSON for objects which are easy to construct in
// javascript but hard to construct in Python and/or Julia.
// For example, we perform the following transformations:
//
//   * Converting "_meshfile" geometries into actual meshes
//     using the THREE.js native mesh loaders
//   * Converting "_text" textures into text by drawing the
//     requested text onto a canvas.
class ExtensibleObjectLoader extends THREE.ObjectLoader {
    delegate(special_handler, base_handler, json, additional_objects) {
        let result = {};
        if (json === undefined) {
            return result;
        }
        let remaining_json = [];
        for (let data of json) {
            let x = special_handler(data);
            if (x !== null) {
                result[x.uuid] = x;
            } else {
                remaining_json.push(data);
            }
        }
        return Object.assign(result, base_handler(remaining_json, additional_objects));
    }

    parseTextures(json, images) {
        return this.delegate(handle_special_texture,
                             super.parseTextures,
                             json, images);
    }

    parseGeometries(json, shapes) {
        return this.delegate(handle_special_geometry,
                             super.parseGeometries,
                             json, shapes);
    }

    parseObject(json, geometries, materials) {
        if (json.type == "_meshfile_object") {
            let geometry;
            let material;
            let manager = new THREE.LoadingManager();
            let path = ( json.url === undefined ) ? undefined : THREE.LoaderUtils.extractUrlBase( json.url );
            manager.setURLModifier(url => {
                if (json.resources[url] !== undefined) {
                    return json.resources[url];
                }
                return url;
            });
            if (json.format == "obj") {
                let loader = new OBJLoader2(manager);
                if (json.mtl_library) {
                    let mtl_loader = new MTLLoader(manager);
                    let mtl_parse_result = mtl_loader.parse(json.mtl_library + "\n", "");
                    let materials = MtlObjBridge.addMaterialsFromMtlLoader(mtl_parse_result);
                    loader.setMaterials(materials);
                    this.onTextureLoad();
                }
                let obj = loader.parse(json.data + "\n", path);
                geometry = merge_geometries(obj, true);
                geometry.uuid = json.uuid;
                material = geometry.material;
            } else if (json.format == "dae") {
                let loader = new ColladaLoader(manager);
                loader.onTextureLoad = this.onTextureLoad;
                let obj = loader.parse(json.data, path);
                geometry = merge_geometries(obj.scene, true);
                geometry.uuid = json.uuid;
                material = geometry.material;
            } else if (json.format == "stl") {
                let loader = new STLLoader();
                geometry = loader.parse(json.data.buffer, path);
                geometry.uuid = json.uuid;
                material = geometry.material;
            } else {
                console.error("Unsupported mesh type:", json);
                return null;
            }
            let object = new THREE.Mesh( geometry, material );

            // Copied from ObjectLoader
            object.uuid = json.uuid;

            if ( json.name !== undefined ) object.name = json.name;

            if ( json.matrix !== undefined ) {

                object.matrix.fromArray( json.matrix );

                if ( json.matrixAutoUpdate !== undefined ) object.matrixAutoUpdate = json.matrixAutoUpdate;
                if ( object.matrixAutoUpdate ) object.matrix.decompose( object.position, object.quaternion, object.scale );

            } else {

                if ( json.position !== undefined ) object.position.fromArray( json.position );
                if ( json.rotation !== undefined ) object.rotation.fromArray( json.rotation );
                if ( json.quaternion !== undefined ) object.quaternion.fromArray( json.quaternion );
                if ( json.scale !== undefined ) object.scale.fromArray( json.scale );

            }

            if ( json.castShadow !== undefined ) object.castShadow = json.castShadow;
            if ( json.receiveShadow !== undefined ) object.receiveShadow = json.receiveShadow;

            if ( json.shadow ) {

                if ( json.shadow.bias !== undefined ) object.shadow.bias = json.shadow.bias;
                if ( json.shadow.radius !== undefined ) object.shadow.radius = json.shadow.radius;
                if ( json.shadow.mapSize !== undefined ) object.shadow.mapSize.fromArray( json.shadow.mapSize );
                if ( json.shadow.camera !== undefined ) object.shadow.camera = this.parseObject( json.shadow.camera );

            }

            if ( json.visible !== undefined ) object.visible = json.visible;
            if ( json.frustumCulled !== undefined ) object.frustumCulled = json.frustumCulled;
            if ( json.renderOrder !== undefined ) object.renderOrder = json.renderOrder;
            if ( json.userjson !== undefined ) object.userjson = json.userData;
            if ( json.layers !== undefined ) object.layers.mask = json.layers;

            return object;
        } else {
            return super.parseObject(json, geometries, materials);
        }
    }
}


class SceneNode {
    constructor(object, folder, on_update) {
        this.object = object;
        this.folder = folder;
        this.children = {};
        this.controllers = [];
        this.on_update = on_update;
        this.create_controls();
        for (let c of this.object.children) {
            this.add_child(c);
        }
    }

    add_child(object) {
        let f = this.folder.addFolder(object.name);
        let node = new SceneNode(object, f, this.on_update);
        this.children[object.name] = node;
        return node;
    }

    create_child(name) {
        let obj = new THREE.Group();
        obj.name = name;
        this.object.add(obj);
        return this.add_child(obj);
    }

    find(path) {
        if (path.length == 0) {
            return this;
        } else {
            let name = path[0];
            let child = this.children[name];
            if (child === undefined) {
                child = this.create_child(name);
            }
            return child.find(path.slice(1));
        }
    }

    create_controls() {
        for (let c of this.controllers) {
            this.folder.remove(c);
        }
        if (this.vis_controller !== undefined) {
            this.folder.domElement.removeChild(this.vis_controller.domElement);
        }
        this.vis_controller = new dat.controllers.BooleanController(this.object, "visible");
        this.vis_controller.onChange(() => this.on_update());
        this.folder.domElement.prepend(this.vis_controller.domElement);
        this.vis_controller.domElement.style.height = "0";
        this.vis_controller.domElement.style.float = "right";
        this.vis_controller.domElement.classList.add("meshcat-visibility-checkbox");
        this.vis_controller.domElement.children[0].addEventListener("change", (evt) => {
            if (evt.target.checked) {
                this.folder.domElement.classList.remove("meshcat-hidden-scene-element");
            } else {
                this.folder.domElement.classList.add("meshcat-hidden-scene-element");
            }
        });
        if (this.object.isLight) {
            let intensity_controller = this.folder.add(this.object, "intensity").min(0).step(0.01);
            intensity_controller.onChange(() => this.on_update());
            this.controllers.push(intensity_controller);
            if (this.object.castShadow !== undefined){
                let cast_shadow_controller = this.folder.add(this.object, "castShadow");
                cast_shadow_controller.onChange(() => this.on_update());
                this.controllers.push(cast_shadow_controller);

                if (this.object.shadow !== undefined) {
                    // Light source radius
                    let radius_controller = this.folder.add(this.object.shadow, "radius").min(0).step(0.05).max(3.0);
                    radius_controller.onChange(() => this.on_update());
                    this.controllers.push(radius_controller);
                }
            }
            // Point light falloff distance
            if (this.object.distance !== undefined){
                let distance_controller = this.folder.add(this.object, "distance").min(0).step(0.1).max(100.0);
                distance_controller.onChange(() => this.on_update());
                this.controllers.push(distance_controller);
            }
        }
        if (this.object.isCamera) {
            let controller = this.folder.add(this.object, "zoom").min(0).step(0.1);
            controller.onChange(() => {
                // this.object.updateProjectionMatrix();
                this.on_update()
            });
            this.controllers.push(controller);
        }
    }

    set_property(property, value) {
        if (property === "position") {
            this.object.position.set(value[0], value[1], value[2]);
        } else if (property === "quaternion") {
            this.object.quaternion.set(value[0], value[1], value[2], value[3]);
        } else if (property === "scale") {
            this.object.scale.set(value[0], value[1], value[2]);
        } else if (property === "color") {
            function setNodeColor(node, value) {
                if (node.material) {
                    node.material.color.setRGB(value[0], value[1], value[2])

                    let alpha = value[3]
                    node.material.opacity = alpha 
                    if(alpha != 1.) {
                       node.material.transparent = true
                    } 
                    else {
                        node.material.transparent = false
                    }
                }
                for (let child of node.children) {
                    setNodeColor(child, value);
                }
            }
            setNodeColor(this.object, value)
        } else if (property == "top_color" || property == "bottom_color") {
            this.object[property] = value.map((x) => x * 255);
        } else {
            this.object[property] = value;
        }
        this.vis_controller.updateDisplay();
        this.controllers.forEach(c => c.updateDisplay());
    }

    set_transform(matrix) {
        let mat = new THREE.Matrix4();
        mat.fromArray(matrix);
        mat.decompose(this.object.position, this.object.quaternion, this.object.scale);
    }

    set_object(object) {
        let parent = this.object.parent;
        this.dispose_recursive();
        this.object.parent.remove(this.object);
        this.object = object;
        parent.add(object);
        this.create_controls();
    }

    dispose_recursive() {
        for (let name of Object.keys(this.children)) {
            this.children[name].dispose_recursive();
        }
        dispose(this.object);
    }

    delete(path) {
        if (path.length == 0) {
            console.error("Can't delete an empty path");
        } else {
            let parent = this.find(path.slice(0, path.length - 1));
            let name = path[path.length - 1];
            let child = parent.children[name];
            if (child !== undefined) {
                child.dispose_recursive();
                parent.object.remove(child.object);
                remove_folders(child.folder);
                parent.folder.removeFolder(child.folder);
                delete parent.children[name];
            }
        }
    }
}

function remove_folders(gui) {
    for (let name of Object.keys(gui.__folders)) {
        let folder = gui.__folders[name];
        remove_folders(folder);
        dat.dom.dom.unbind(window, 'resize', folder.__resizeHandler);
        gui.removeFolder(folder);
    }
}

function dispose(object) {
    if (!object) {
        return;
    }
    if (object.geometry) {
        object.geometry.dispose();
    }
    if (object.material) {
        if (Array.isArray(object.material)) {
            for (let material of object.material) {
                if (material.map) {
                    material.map.dispose();
                }
                material.dispose();
            }
        } else {
            if (object.material.map) {
                object.material.map.dispose();
            }
            object.material.dispose();
        }
    }
}

function create_default_scene() {
    var scene = new THREE.Scene();
    scene.name = "Scene";
    scene.rotateX(-Math.PI / 2);
    return scene;
}


// https://stackoverflow.com/a/15832662
function download_data_uri(name, uri) {
    let link = document.createElement("a");
    link.download = name;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// https://stackoverflow.com/a/35251739
function download_file(name, contents, mime) {
    mime = mime || "text/plain";
    let blob = new Blob([contents], {
        type: mime
    });
    let link = document.createElement("a");
    document.body.appendChild(link);
    link.download = name;
    link.href = window.URL.createObjectURL(blob);
    link.onclick = function(e) {
        let scope = this;
        setTimeout(function() {
            window.URL.revokeObjectURL(scope.href);
        }, 1500);
    };
    link.click();
    link.remove();
}

class Animator {
    constructor(viewer) {
        this.viewer = viewer;
        this.folder = this.viewer.gui.addFolder("Animations");
        this.mixer = new THREE.AnimationMixer();
        this.loader = new THREE.ObjectLoader();
        this.clock = new THREE.Clock();
        this.actions = [];
        this.playing = false;
        this.recording = false;
        this.recordFormat = 'mp4'; // Set default format to mp4
        this.capturer = null; // For ccapture.js

        // MP4 specific state
        this.capturedFrames = [];
        this.ffmpeg = null;
        this.ffmpegLoading = false;
        this.encoding = false;
        this.statusElement = null;
        this.recordingFolderController = null; // Add property to store ref

        this.time = 0;
        this.time_scrubber = null;
        this.timeScaleController = null;
        this.duration = 0;
        this.setup_capturer(); // Initial setup
    }

    setup_capturer() {
        // Only setup ccapture if format is png/jpg
        if (this.recordFormat === 'png' || this.recordFormat === 'jpg') {
            this.capturer = new window.CCapture({
                format: this.recordFormat,
                name: "meshcat_" + String(Date.now())
            });
        } else {
            this.capturer = null; // Ensure capturer is null for MP4 mode
        }
        // Reset MP4 state if switching away from MP4
        if (this.recordFormat !== 'mp4') {
             this.capturedFrames = [];
             this.setStatus(""); // Clear status
        }
    }

    play() {
        this.clock.start();
        for (let action of this.actions) {
            action.play();
        }
        this.playing = true;
    }

    record() {
        if (this.encoding || this.ffmpegLoading) {
             console.warn("Already loading/encoding MP4.");
             return;
        }
        this.reset(); // Resets animation time and capturer/frames
        this.recording = true;

        if (this.recordFormat === 'mp4') {
            this.capturedFrames = []; // Clear previous frames
            this.setStatus("Recording MP4... Press Pause (Spacebar) to finish.");
        } else if (this.capturer) {
            this.capturer.start();
            this.setStatus(`Recording ${this.recordFormat.toUpperCase()}... Press Pause (Spacebar) to finish.`);
        }
        this.play();
    }

    pause() {
        this.clock.stop();
        this.playing = false;

        if (this.recording) {
            this.recording = false; // Stop capturing frames
            if (this.recordFormat === 'mp4') {
                this.processMp4Recording(); // Start MP4 encoding
            } else if (this.capturer) {
                this.stop_image_capture();
                this.save_image_capture();
            }
        }
    }

    // --- Image Sequence (PNG/JPG) Methods ---
    stop_image_capture() {
        if (!this.capturer) return;
        this.capturer.stop();
        this.viewer.animate(); // Restore animation loop
        this.setStatus(`Stopped ${this.recordFormat.toUpperCase()} recording.`);
    }

    save_image_capture() {
        if (!this.capturer) return;
        this.capturer.save();
        this.setStatus(`Saved ${this.recordFormat.toUpperCase()} sequence. Use ffmpeg to convert.`);
        // Keep the alert as a reminder
        if (this.recordFormat === "png") {
            alert("To convert the still frames into a video, extract the `.tar` file and run: \nffmpeg -r 60 -i %07d.png \
\t -vcodec libx264 \
\t -preset slow \
\t -crf 18 \
\t output.mp4");
        } else if (this.recordFormat === "jpg") {
            alert("To convert the still frames into a video, extract the `.tar` file and run: \nffmpeg -r 60 -i %07d.jpg \
\t -vcodec libx264 \
\t -preset slow \
\t -crf 18 \
\t output.mp4");
        }
    }

    // --- MP4 Encoding Method ---
    async processMp4Recording() {
        if (!this.capturedFrames || this.capturedFrames.length === 0) {
            this.setStatus("No frames captured for MP4.");
            return;
        }
        if (this.encoding || this.ffmpegLoading) {
             console.warn("Already loading/encoding MP4.");
             return;
        }

        this.encoding = true;
        this.ffmpegLoading = true;
        this.setStatus("Loading video encoder...");

        try {
            // Initialize FFmpeg (now using statically imported function)
            if (!this.ffmpeg) {
                // Explicitly set corePath to CDN to work reliably from http://localhost 
                // and avoid relying on local node_modules path.
                const corePath = 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js';
                this.ffmpeg = createFFmpeg({
                    log: true, 
                    corePath: corePath, 
                    progress: ({ ratio }) => {
                        if (ratio > 0 && ratio <= 1) {
                            this.setStatus(`Encoding MP4: ${(ratio * 100).toFixed(1)}%`);
                        }
                    }
                });
            }
            if (!this.ffmpeg.isLoaded()) {
                await this.ffmpeg.load();
            }
            this.ffmpegLoading = false;
            this.setStatus(`Encoding ${this.capturedFrames.length} frames to MP4...`);

            for (let i = 0; i < this.capturedFrames.length; i++) {
                const frameName = `frame_${String(i + 1).padStart(7, '0')}.png`;
                this.ffmpeg.FS('writeFile', frameName, await fetchFile(this.capturedFrames[i]));
            }

            // Run ffmpeg. 
            // -threads 1 is used for stability as multi-threading (0) seems unreliable.
            await this.ffmpeg.run(
                '-r', '30', '-i', 'frame_%07d.png',
                '-threads', '1', // Force single thread for stability
                '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
                '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
                'output.mp4'
            );

            const data = this.ffmpeg.FS('readFile', 'output.mp4');
            const blob = new Blob([data.buffer], { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            download_data_uri('meshcat_video.mp4', url);
            this.setStatus(`MP4 encoding complete. Video downloaded.`);

            // Clean up MEMFS
            for (let i = 0; i < this.capturedFrames.length; i++) {
                 this.ffmpeg.FS('unlink', `frame_${String(i + 1).padStart(7, '0')}.png`);
             }
             this.ffmpeg.FS('unlink', 'output.mp4');

        } catch (error) {
            console.error("FFmpeg encoding error:", error);
            // Check if error suggests missing COOP/COEP headers
            const errorString = error.toString().toLowerCase();
            if (errorString.includes('sharedarraybuffer') || 
                (errorString.includes('failed to fetch') && errorString.includes('ffmpeg-core'))) {
                this.setStatus("MP4 Failed: Server Headers Missing (COOP/COEP).");
                this.showCopyServerCommandButton(); // Show button
            } else {
                 this.setStatus("Error during MP4 encoding.");
            }
        } finally {
            this.encoding = false;
            this.capturedFrames = []; // Clear frames
        }
    }

    showCopyServerCommandButton() {
        // Prevent adding multiple buttons
        if (document.getElementById('meshcat-copy-cmd-button')) {
            return;
        }
        
        const button = document.createElement('button');
        button.id = 'meshcat-copy-cmd-button';
        button.textContent = 'Copy Server Cmd for MP4';
        button.title = 'Copies the Python command to run a local server with required headers for MP4 export in static HTML.';
        button.style.marginTop = '5px'; // Add some space
        button.style.padding = '4px 8px';
        button.style.fontSize = '0.9em';
        button.style.cursor = 'pointer';

        const commandText = "python -c \"import http.server as hs, socketserver as ss; H=hs.SimpleHTTPRequestHandler; H.end_headers = lambda self: (self.send_header('Cross-Origin-Opener-Policy','same-origin'), self.send_header('Cross-Origin-Embedder-Policy','require-corp'), super(H, self).end_headers()); ss.TCPServer(('', 8000), H).serve_forever()\"";

        button.addEventListener('click', () => {
            navigator.clipboard.writeText(commandText).then(() => {
                button.textContent = 'Copied!';
                button.disabled = true;
                setTimeout(() => {
                    // Optionally remove button or re-enable after a delay
                    // button.textContent = 'Copy Server Cmd for MP4';
                    // button.disabled = false;
                    button.remove(); // Remove after successful copy
                }, 2000); 
            }).catch(err => {
                console.error('Failed to copy command: ', err);
                button.textContent = 'Copy Failed';
                button.title = 'Could not copy command to clipboard.';
                 setTimeout(() => {
                     button.remove(); // Remove button on failure too
                 }, 2000);
            });
        });

        // Find the recording folder's DOM element to append the button
        // Need a reference to the recording_folder GUI controller
        // We'll need to store this reference in the Animator
        if (this.recordingFolderController && this.recordingFolderController.domElement) {
            this.recordingFolderController.domElement.appendChild(button);
        } else {
            console.warn("Could not find recording folder DOM element to attach copy button.");
            // Fallback: append near status element (less ideal layout)
            if(this.statusElement && this.statusElement.parentElement) {
                 this.statusElement.parentElement.appendChild(button);
            }
        }
    }

    setStatus(message) {
        console.log("Status:", message);
        if (this.statusElement) {
            this.statusElement.textContent = message;
            // Add/remove active class based on whether message is empty
            if (message && message.trim() !== "") {
                 this.statusElement.classList.add('status-message-active');
            } else {
                this.statusElement.classList.remove('status-message-active');
            }
        }
    }

    display_progress(time) {
        this.time = time;
        if (this.time_scrubber !== null) {
            this.time_scrubber.updateDisplay();
        }
    }

    seek(time) {
        this.actions.forEach((action) => {
            action.time = Math.max(0, Math.min(action._clip.duration, time));
        });
        this.mixer.update(0);
        this.viewer.set_dirty();
    }

    reset() {
        // Reset existing actions to their initial state
        for (let action of this.actions) {
            action.reset();
            // Ensure actions are not paused if we expect play to work after reset
            // action.paused = false; // Optional: Might be needed depending on how play is called
        }
        // Reset the mixer's time and update objects to initial pose
        this.mixer.setTime(0);
        this.mixer.update(0);
        
        // Reset playback state
        this.playing = false;
        this.clock.stop();
        this.display_progress(0); // Reset time display
        
        // Reset recording state
        this.recording = false;
        this.capturedFrames = [];
        this.setStatus("");
        // Re-setup capturer based on current format (important for PNG/JPG)
        this.setup_capturer(); 
        
        this.viewer.set_dirty(); // Request redraw
    }

    clear() {
        remove_folders(this.folder);
        if (this.mixer) { // Check if mixer exists before stopping
             this.mixer.stopAllAction();
        }
        this.actions = [];
        this.duration = 0;
        this.display_progress(0);
        // It's generally safer to reuse the mixer instance if possible,
        // but creating a new one on clear might be intended.
        // If creating new, ensure scene graph connections are handled correctly.
        // this.mixer = new THREE.AnimationMixer(); 
        
        // Reset GUI controller references
        this.timeScaleController = null; 
        this.time_scrubber = null; 
        this.recordingFolderController = null; 
        if (this.statusElement) this.statusElement.textContent = "";
    }

    load(animations, options) {
        this.clear();

        this.folder.open();
        let folder = this.folder.addFolder("default");
        folder.open();
        folder.add(this, "play");
        folder.add(this, "pause");
        folder.add(this, "reset");

        this.time_scrubber = folder.add(this, "time", 0, 1e9, 0.001);
        this.time_scrubber.onChange((value) => this.seek(value));

        this.timeScaleController = folder.add(this.mixer, "timeScale").step(0.01).min(0).name("Speed");

        // Store reference to the recording folder controller
        this.recordingFolderController = folder.addFolder("Recording");
        this.recordingFolderController.add(this, "record").name("Record"); // Generic button
        this.recordingFolderController.add(this, "recordFormat", ["png", "jpg", "mp4"]).name("Format").onChange(value => {
             this.recordFormat = value;
             this.setup_capturer(); // Re-run setup when format changes
             this.reset(); // Reset state when changing format
        });

        // Add status display element (used by MP4 encoding)
        this.statusElement = document.createElement('div');
        this.statusElement.style.padding = '5px';
        this.statusElement.style.color = '#ccc';
        this.statusElement.style.fontSize = '0.9em';
        this.recordingFolderController.domElement.appendChild(this.statusElement);

        this.duration = 0;
        this.progress = 0;
        for (let animation of animations) {
            let target = this.viewer.scene_tree.find(animation.path).object;
            let clip = THREE.AnimationClip.parse(animation.clip);
            clip.uuid = THREE.MathUtils.generateUUID();
            let action = this.mixer.clipAction(clip, target);
            action.clampWhenFinished = options.clampWhenFinished;
            action.setLoop(options.loopMode, options.repetitions);
            this.actions.push(action);
            this.duration = Math.max(this.duration, clip.duration);
        }
        this.time_scrubber.min(0);
        this.time_scrubber.max(this.duration);
        this.reset();
        if (options.play !== false) {
            this.play();
        }
    }

    update() {
        if (this.playing) {
            this.mixer.update(this.clock.getDelta());
            this.viewer.set_dirty();
            if (this.duration != 0) {
                let current_time = this.actions.reduce((acc, action) => {
                    // Use Math.max with action.time and duration - epsilon to handle potential overshoot slightly
                    // while still allowing it to reach the end if looping.
                    // A better approach might be to rely solely on the isFinished check below.
                    return Math.max(acc, action.time);
                }, 0);
                // Clamp time display to duration if it slightly overshoots
                this.time = Math.min(current_time, this.duration);
                this.display_progress(this.time);
            } else {
                this.time = 0;
                this.display_progress(0);
            }

            // Check 1: If animation naturally pauses (non-looping completed)
            if (this.actions.every((action) => action.paused)) {
                console.log("Animation naturally paused.");
                this.pause(); // Automatically pauses when animation ends
                // Resetting here might interfere if we want encoding to happen first
                // Let pause handle the state transition
                // for (let action of this.actions) {
                //     action.reset();
                // }
            }
            // Check 2: If recording and time reaches duration (for looping animations)
            else if (this.recording && this.duration > 0 && this.time >= this.duration) {
                console.log("Recording reached duration, triggering pause.");
                // We might need a small tolerance check if time slightly exceeds duration due to delta
                this.pause(); // Trigger pause to stop recording and start encoding/saving
            }
        }
    }

    after_render() {
        if (this.recording) {
            if (this.recordFormat === 'mp4') {
                // Capture frame for MP4 encoding
                const frameDataUrl = this.viewer.renderer.domElement.toDataURL('image/png');
                this.capturedFrames.push(frameDataUrl);
            } else if (this.capturer) {
                // Capture frame using ccapture for PNG/JPG
                this.capturer.capture(this.viewer.renderer.domElement);
            }
        }
    }
}

// Generates a gradient texture without filling up
// an entire canvas. We simply create a 2x1 image
// containing only the two colored pixels and then
// set up the appropriate magnification and wrapping
// modes to generate the gradient automatically
function gradient_texture(top_color, bottom_color) {
    let colors = [bottom_color, top_color];

    let width = 1;
    let height = 2;
    let size = width * height;
    var data = new Uint8Array(3 * size);
    for (let row = 0; row < height; row++) {
        let color = colors[row];
        for (let col = 0; col < width; col++) {
            let i = 3 * (row * width + col);
            for (let j = 0; j < 3; j++) {
                data[i + j] = color[j];
            }
        }
    }
    var texture = new THREE.DataTexture(data, width, height, THREE.RGBFormat);
    texture.magFilter = THREE.LinearFilter;
    texture.encoding = THREE.LinearEncoding;
    texture.matrixAutoUpdate = false;
    texture.matrix.set(0.5, 0, 0.25,
        0, 0.5, 0.25,
        0, 0, 1);
    texture.needsUpdate = true
    return texture;
}


class Viewer {
    constructor(dom_element, animate, renderer) {
        this.dom_element = dom_element;
        // Add a style block to ensure parent has relative positioning if needed
        if (getComputedStyle(this.dom_element.parentElement).position === 'static') {
             this.dom_element.parentElement.style.position = 'relative';
        }
        if (renderer === undefined) {
            this.renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
            this.renderer.shadowMap.enabled = true;
            this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            this.dom_element.appendChild(this.renderer.domElement);
        } else {
            this.renderer = renderer;
        }
        this.renderer.setPixelRatio(window.devicePixelRatio);

        this.scene = create_default_scene();
        this.gui_controllers = {};
        this.searchHandler = { searchTerm: "" }; // Holder for search term
        this.create_scene_tree();

        this.add_default_scene_elements();
        this.set_dirty();

        this.create_camera();
        this.num_messages_received = 0;

        window.onload = (evt) => this.set_3d_pane_size();
        window.addEventListener('resize', (evt) => this.set_3d_pane_size(), false);

        window.addEventListener('keydown', (event) => {
            const frameStep = 1 / 30;
            let currentTime = this.animator.time;
            let duration = this.animator.duration;
            let newTime;

            switch (event.code) {
                case 'Space':
                    event.preventDefault();
                    if (this.animator.playing) {
                        this.animator.pause();
                    } else {
                        this.animator.play();
                    }
                    break;
                case 'KeyR':
                    // Only prevent default if NO modifier keys are pressed
                    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
                         event.preventDefault();
                    }
                    // Still reset the animator regardless of modifiers
                    this.animator.reset();
                    break;
                case 'ArrowLeft':
                    event.preventDefault();
                    if (this.animator.playing) {
                         this.animator.pause();
                    }
                    newTime = Math.max(0, currentTime - frameStep);
                    this.animator.seek(newTime);
                    this.animator.display_progress(newTime);
                    break;
                case 'ArrowRight':
                    event.preventDefault();
                     if (this.animator.playing) {
                         this.animator.pause();
                    }
                    newTime = Math.min(duration, currentTime + frameStep);
                    this.animator.seek(newTime);
                    this.animator.display_progress(newTime);
                    break;
                case 'Digit1': // Key '1' for 0.01x speed
                    event.preventDefault();
                    this.animator.mixer.timeScale = 0.01;
                    if (this.animator.timeScaleController) this.animator.timeScaleController.updateDisplay();
                    break;
                case 'Digit2': // Key '2' for 0.1x speed
                    event.preventDefault();
                    this.animator.mixer.timeScale = 0.1;
                    if (this.animator.timeScaleController) this.animator.timeScaleController.updateDisplay();
                    break;
                case 'Digit3': // Key '3' for 0.5x speed
                    event.preventDefault();
                    this.animator.mixer.timeScale = 0.5;
                    if (this.animator.timeScaleController) this.animator.timeScaleController.updateDisplay();
                    break;
                case 'Digit4': // Key '4' for 1.0x speed
                    event.preventDefault();
                    this.animator.mixer.timeScale = 1.0;
                    if (this.animator.timeScaleController) this.animator.timeScaleController.updateDisplay();
                    break;
                case 'Digit5': // Key '5' for 2.0x speed
                    event.preventDefault();
                    this.animator.mixer.timeScale = 2.0;
                    if (this.animator.timeScaleController) this.animator.timeScaleController.updateDisplay();
                    break;
            }
        });

        // Bind methods for callbacks
        this.filterSceneTree = this.filterSceneTree.bind(this);
        this.disableFiltered = this.disableFiltered.bind(this);
        this.enableFiltered = this.enableFiltered.bind(this);

        // Create Help UI
        this.createHelpUI();

        requestAnimationFrame(() => this.set_3d_pane_size());
        if (animate || animate === undefined) {
            this.animate();
        }
    }

    createHelpUI() {
        const helpButton = document.createElement('div');
        helpButton.id = 'meshcat-help-button';
        helpButton.textContent = '?';
        helpButton.title = 'Show/Hide Keyboard Shortcuts'; // Add hover tooltip

        const helpPanel = document.createElement('div');
        helpPanel.id = 'meshcat-help-panel';
        helpPanel.innerHTML = `
<strong>Keyboard Shortcuts:</strong>
------------------------------------
<b>Spacebar:</b> Play / Pause Animation
<b>R:</b> Reset Animation
<b>Left Arrow:</b> Step Back Frame
<b>Right Arrow:</b> Step Forward Frame
<b>1:</b> Set Speed 0.01x
<b>2:</b> Set Speed 0.1x
<b>3:</b> Set Speed 0.5x
<b>4:</b> Set Speed 1.0x
<b>5:</b> Set Speed 2.0x
        `.trim(); // Use trim() to remove potential leading/trailing whitespace from the whole template literal

        // Add elements to the viewer's PARENT container (alongside dat.gui)
        if (this.dom_element.parentElement) { // Ensure parent exists
            this.dom_element.parentElement.appendChild(helpButton);
            this.dom_element.parentElement.appendChild(helpPanel);
        } else {
            console.error("Could not find parent element to attach help UI.");
             // Fallback: append to body or the element itself, might have issues
            // document.body.appendChild(helpButton);
            // document.body.appendChild(helpPanel);
            this.dom_element.appendChild(helpButton);
             this.dom_element.appendChild(helpPanel);
        }

        // Toggle panel visibility on button click
        helpButton.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent click from immediately closing panel
            helpPanel.classList.toggle('help-panel-visible');
        });
    }

    hide_background() {
        this.scene.background = null;
        this.set_dirty();
    }

    show_background() {
        var top_color = this.scene_tree.find(["Background"]).object.top_color;
        var bottom_color =
            this.scene_tree.find(["Background"]).object.bottom_color;
        this.scene.background = gradient_texture(top_color, bottom_color);
        this.set_dirty();
    }

    set_dirty() {
        this.needs_render = true;
    }

    create_camera() {
        let mat = new THREE.Matrix4();
        mat.makeRotationX(Math.PI / 2);
        this.set_transform(["Cameras", "default", "rotated"], mat.toArray());

        let camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100)
        this.set_camera(camera);

        this.set_object(["Cameras", "default", "rotated"], camera)
        camera.position.set(3, 1, 0);
    }

    create_default_spot_light() {
        var spot_light = new THREE.SpotLight(0xffffff, 0.8);
        spot_light.position.set(1.5, 1.5, 2);
        spot_light.castShadow = false;
        spot_light.shadow.mapSize.width = 1024;
        spot_light.shadow.mapSize.height = 1024;
        spot_light.shadow.camera.near = 0.5;
        spot_light.shadow.camera.far = 50.;
        spot_light.shadow.bias = -0.001;
        return spot_light;
    }

    add_default_scene_elements() {
        var spot_light = this.create_default_spot_light();
        this.set_object(["Lights", "SpotLight"], spot_light);
        this.set_property(["Lights", "SpotLight"], "visible", false);

        var point_light_px = new THREE.PointLight(0xffffff, 0.4);
        point_light_px.position.set(1.5, 1.5, 2);
        point_light_px.castShadow = false;
        point_light_px.distance = 10.0;
        point_light_px.shadow.mapSize.width = 1024;
        point_light_px.shadow.mapSize.height = 1024;
        point_light_px.shadow.camera.near = 0.5;
        point_light_px.shadow.camera.far = 10.;
        point_light_px.shadow.bias = -0.001;
        this.set_object(["Lights", "PointLightNegativeX"], point_light_px);

        var point_light_nx = new THREE.PointLight(0xffffff, 0.4);
        point_light_nx.position.set(-1.5, -1.5, 2);
        point_light_nx.castShadow = false;
        point_light_nx.distance = 10.0;
        point_light_nx.shadow.mapSize.width = 1024;
        point_light_nx.shadow.mapSize.height = 1024;
        point_light_nx.shadow.camera.near = 0.5;
        point_light_nx.shadow.camera.far = 10.;
        point_light_nx.shadow.bias = -0.001;
        this.set_object(["Lights", "PointLightPositiveX"], point_light_nx);

        var ambient_light = new THREE.AmbientLight(0xffffff, 0.3);
        ambient_light.intensity = 0.6;
        this.set_object(["Lights", "AmbientLight"], ambient_light);

        var fill_light = new THREE.DirectionalLight(0xffffff, 0.4);
        fill_light.position.set(-10, -10, 0);
        this.set_object(["Lights", "FillLight"], fill_light);

        var grid = new THREE.GridHelper(20, 40);
        grid.rotateX(Math.PI / 2);
        this.set_object(["Grid"], grid);

        var axes = new THREE.AxesHelper(0.5);
        this.set_object(["Axes"], axes);
    }

    create_scene_tree() {
        if (this.gui) {
            this.gui.destroy();
        }
        this.gui = new dat.GUI({
            autoPlace: false
        });
        this.dom_element.parentElement.appendChild(this.gui.domElement);
        this.gui.domElement.style.position = "absolute";
        this.gui.domElement.style.right = 0;
        this.gui.domElement.style.top = 0;

        let scene_folder = this.gui.addFolder("Scene");
        scene_folder.open();
        
        // ADD Search Bar and buttons INSIDE Scene folder
        scene_folder.add(this.searchHandler, 'searchTerm').name('Filter Name').onChange(this.filterSceneTree);
        scene_folder.add(this, 'enableFiltered').name('Enable Filtered');
        scene_folder.add(this, 'disableFiltered').name('Disable Filtered');
        
        // Add SceneNode tree AFTER the controls
        this.scene_tree = new SceneNode(this.scene, scene_folder, () => this.set_dirty());
        
        let save_folder = this.gui.addFolder("Save / Load / Capture");
        save_folder.add(this, 'save_scene');
        save_folder.add(this, 'load_scene');
        save_folder.add(this, 'save_image');
        this.animator = new Animator(this);
        // this.gui.close(); 

        this.set_property(["Background"],
            "top_color", [135/255, 206/255, 250/255]);
        this.set_property(["Background"],
            "bottom_color", [25/255, 25/255, 112/255]);
        this.scene_tree.find(["Background"]).on_update = () => {
            if (this.scene_tree.find(["Background"]).object.visible)
                this.show_background();
            else
                this.hide_background();
        };
        this.show_background();
    }

    set_3d_pane_size(w, h) {
        if (w === undefined) {
            w = this.dom_element.offsetWidth;
        }
        if (h === undefined) {
            h = this.dom_element.offsetHeight;
        }
        if (this.camera.type == "OrthographicCamera") {
            this.camera.right = this.camera.left + w*(this.camera.top - this.camera.bottom)/h;
        } else {
            this.camera.aspect = w / h;
        }
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.set_dirty();
    }

    render() {
        this.controls.update();
        this.camera.updateProjectionMatrix();
        this.renderer.render(this.scene, this.camera);
        this.animator.after_render();
        this.needs_render = false;
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.animator.update();
        if (this.needs_render) {
            this.render();
        }
    }

    capture_image(w, h) {
        let w_prev = this.dom_element.offsetWidth;
        let h_prev = this.dom_element.offsetHeight;
        this.set_3d_pane_size(w, h);
        this.render();
        let data = this.renderer.domElement.toDataURL();
        this.set_3d_pane_size(w_prev, h_prev);
        return data;
    }

    save_image() {
        download_data_uri("meshcat.png", this.capture_image());
    }

    set_camera(obj) {
        this.camera = obj;
        this.controls = new OrbitControls(obj, this.dom_element);
        this.controls.enableKeys = false;
        this.controls.screenSpacePanning = true;
        this.controls.addEventListener('start', () => {
            this.set_dirty()
        });
        this.controls.addEventListener('change', () => {
            this.set_dirty()
        });
    }

    set_camera_target(value) {
        this.controls.target.set(value[0], value[1], value[2]);
    }

    set_camera_from_json(data) {
        let loader = new ExtensibleObjectLoader();
        loader.parse(data, (obj) => {
            this.set_camera(obj);
        });
    }

    set_transform(path, matrix) {
        this.scene_tree.find(path).set_transform(matrix);
    }

    set_object(path, object) {
        this.scene_tree.find(path.concat(["<object>"])).set_object(object);
    }

    set_object_from_json(path, object_json) {
        let loader = new ExtensibleObjectLoader();
        loader.onTextureLoad = () => {this.set_dirty();}
        loader.parse(object_json, (obj) => {
            if (obj.geometry !== undefined && obj.geometry.type == "BufferGeometry") {
                if ((obj.geometry.attributes.normal === undefined) || obj.geometry.attributes.normal.count === 0) {
                    obj.geometry.computeVertexNormals();
                }
            } else if (obj.type.includes("Camera")) {
                this.set_camera(obj);
                this.set_3d_pane_size();                
            }
            obj.castShadow = true;
            obj.receiveShadow = true;
            this.set_object(path, obj);
            this.set_dirty();
        });
    }

    delete_path(path) {
        if (path.length == 0) {
            console.error("Deleting the entire scene is not implemented")
        } else {
            this.scene_tree.delete(path);
        }
    }

    set_property(path, property, value) {
        this.scene_tree.find(path).set_property(property, value);
        if (path[0] === "Background") {
            this.scene_tree.find(path).on_update();
        }
    }

    set_animation(animations, options) {
        options = options || {};
        this.animator.load(animations, options);
    }

    set_control(name, callback, value, min, max, step) {
        let handler = {};
        if (name in this.gui_controllers) {
            this.gui.remove(this.gui_controllers[name]);
        }
        if (value !== undefined) {
            handler[name] = value;
            this.gui_controllers[name] = this.gui.add(
                handler, name, min, max, step);
            this.gui_controllers[name].onChange(eval(callback));
        } else {
            handler[name] = eval(callback);
            this.gui_controllers[name] = this.gui.add(handler, name);
            this.gui_controllers[name].domElement.parentElement.querySelector('.property-name').style.width="100%";
        }
    }

    set_control_value(name, value, invoke_callback=true) {
        if (name in this.gui_controllers && this.gui_controllers[name] 
            instanceof dat.controllers.NumberController) {
            if (invoke_callback) {
              this.gui_controllers[name].setValue(value);              
            } else {
              this.gui_controllers[name].object[name] = value;
              this.gui_controllers[name].updateDisplay();
            }
        }
    }

    delete_control(name) {
        if (name in this.gui_controllers) {
            this.gui.remove(this.gui_controllers[name]);
            delete this.gui_controllers[name];
        }
    }

    handle_command(cmd) {
        if (cmd.type == "set_transform") {
            let path = split_path(cmd.path);
            this.set_transform(path, cmd.matrix);
        } else if (cmd.type == "delete") {
            let path = split_path(cmd.path);
            this.delete_path(path);
        } else if (cmd.type == "set_object") {
            let path = split_path(cmd.path);
            this.set_object_from_json(path, cmd.object);
        } else if (cmd.type == "set_property") {
            let path = split_path(cmd.path);
            this.set_property(path, cmd.property, cmd.value);
        } else if (cmd.type == "set_animation") {
            cmd.animations.forEach(animation => {
                animation.path = split_path(animation.path);
            });
            this.set_animation(cmd.animations, cmd.options);
        } else if (cmd.type == "set_target") {
            this.set_camera_target(cmd.value);
        } else if (cmd.type == "set_control") {
            this.set_control(cmd.name, cmd.callback, cmd.value, cmd.min, cmd.max, cmd.step);
        } else if (cmd.type == "set_control_value") {
            this.set_control_value(cmd.name, cmd.value, cmd.invoke_callback);
        } else if (cmd.type == "delete_control") {
            this.delete_control(cmd.name);
        } else if (cmd.type == "capture_image") {
            let w = cmd.xres || 1920;
            let h = cmd.yres || 1080;
            w = w / this.renderer.getPixelRatio();
            h = h / this.renderer.getPixelRatio();
            let imgdata = this.capture_image(w, h);
            this.connection.send(JSON.stringify({
                'type': 'img',
                'data': imgdata
            }));
        } else if (cmd.type == "save_image") {
            this.save_image()
        }
        this.set_dirty();
    }

    handle_command_bytearray(bytearray) {
        let decoded = msgpack.decode(bytearray);
        this.handle_command(decoded);
    }
    
    handle_command_message(message) {
        this.num_messages_received++;
        this.handle_command_bytearray(new Uint8Array(message.data));
    }

    connect(url) {
        if (url === undefined) {
            url = `ws://${location.host}`;
        }
        if (location.protocol == "https:") {
            url = url.replace("ws:", "wss:");
        }
        this.connection = new WebSocket(url);
        this.connection.binaryType = "arraybuffer";
        this.connection.onmessage = (msg) => this.handle_command_message(msg);
        this.connection.onclose = function(evt) {
            console.log("onclose:", evt);
        }
    }

    save_scene() {
        download_file("scene.json", JSON.stringify(this.scene.toJSON()));
    }

    load_scene_from_json(json) {
        let loader = new ExtensibleObjectLoader();
        loader.onTextureLoad = () => {this.set_dirty();}
        this.scene_tree.dispose_recursive();
        this.scene = loader.parse(json);
        this.show_background();
        this.create_scene_tree();
        let cam_node = this.scene_tree.find(["Cameras", "default", "rotated", "<object>"]);
        if (cam_node.object.isCamera) {
            this.set_camera(cam_node.object);
        } else {
            this.create_camera();
        }
    }

    handle_load_file(input) {
        let file = input.files[0];
        if (!file) {
            return
        }
        let reader = new FileReader();
        let viewer = this;
        reader.onload = function(e) {
            let contents = this.result;
            let json = JSON.parse(contents);
            viewer.load_scene_from_json(json);
        };
        reader.readAsText(file);
    }

    load_scene() {
        let input = document.createElement("input");
        input.type = "file";
        document.body.appendChild(input);
        let self = this;
        input.addEventListener("change", function() {
            console.log(this, self);
            self.handle_load_file(this);
        }, false);
        input.click();
        input.remove();
    }

    filterSceneTree() {
        const searchTerm = this.searchHandler.searchTerm.toLowerCase();

        function recursiveFilter(node, term) {
            let nodeMatch = false;
            if (node.object && node.object.name) {
                nodeMatch = node.object.name.toLowerCase().includes(term);
            }

            let childrenMatch = false;
            for (const childName in node.children) {
                const childVisible = recursiveFilter(node.children[childName], term);
                childrenMatch = childrenMatch || childVisible;
            }

            const shouldShow = nodeMatch || childrenMatch || term === ""; // Show if node or any child matches, or if search is empty
            
            // Apply visibility to the GUI folder element (if it exists)
            // Root node (this.scene_tree) might not have a folder directly associated in the same way?
            // Skip the root scene node itself, only filter its children folders.
            if (node.folder && node.folder.domElement) { 
                node.folder.domElement.style.display = shouldShow ? 'block' : 'none';
            }

            return shouldShow; // Return if this node or its descendants should be visible
        }

        // Start filtering from the direct children of the main scene tree root
        for (const childName in this.scene_tree.children) {
             recursiveFilter(this.scene_tree.children[childName], searchTerm);
         }
    }

    enableFiltered() {
        const searchTerm = this.searchHandler.searchTerm.toLowerCase();
        if (searchTerm === "") {
            console.log("Search term is empty, nothing to enable.");
            return;
        }
        console.log(`Enabling objects matching: "${searchTerm}"`);

        let enabledCount = 0;
        function recursiveEnable(node, term) {
            if (node.object && node.object.name && node.object.name.toLowerCase().includes(term)) {
                // Check if it's currently hidden and has a visibility controller
                if (!node.object.visible && node.vis_controller) {
                    node.object.visible = true;
                    node.vis_controller.setValue(true);
                    enabledCount++;
                }
            }

            // Recurse into children
            for (const childName in node.children) {
                recursiveEnable(node.children[childName], term);
            }
        }

        recursiveEnable(this.scene_tree, searchTerm); // Start from the root
        if (enabledCount > 0) {
            console.log(`Enabled ${enabledCount} matching objects.`);
            this.set_dirty(); // Request redraw
        } else {
            console.log("No hidden objects found matching the filter.");
        }
    }

    disableFiltered() {
        const searchTerm = this.searchHandler.searchTerm.toLowerCase();
        if (searchTerm === "") {
            console.log("Search term is empty, nothing to disable.");
            return;
        }
        console.log(`Disabling objects matching: "${searchTerm}"`);

        let disabledCount = 0;
        function recursiveDisable(node, term) {
            if (node.object && node.object.name && node.object.name.toLowerCase().includes(term)) {
                // Check if it's not already hidden and has a visibility controller
                if (node.object.visible && node.vis_controller) {
                    node.object.visible = false;
                    // Use internal _setValue to avoid triggering onChange if that causes issues
                    // node.vis_controller._setValue(false); 
                    // Safer: Use the documented way which might trigger onChange
                    node.vis_controller.setValue(false);
                    disabledCount++;
                }
            }

            // Recurse into children
            for (const childName in node.children) {
                recursiveDisable(node.children[childName], term);
            }
        }

        recursiveDisable(this.scene_tree, searchTerm); // Start from the root
        if (disabledCount > 0) {
            console.log(`Disabled ${disabledCount} matching objects.`);
            this.set_dirty(); // Request redraw
        } else {
            console.log("No visible objects found matching the filter.");
        }
    }
}

function split_path(path_str) {
    return path_str.split("/").filter(x => x.length > 0);
}

let style = document.createElement("style");
style.appendChild(document.createTextNode(("")));
document.head.appendChild(style);
style.sheet.insertRule(`
    .meshcat-visibility-checkbox > input {
        float: right;
    }`);
style.sheet.insertRule(`
   .meshcat-hidden-scene-element li .meshcat-visibility-checkbox {
        opacity: 0.25;
        pointer-events: none;
    }`);
style.sheet.insertRule(`
    .meshcat-visibility-checkbox > input[type=checkbox] {
        height: 16px;
        width: 16px;
        display:inline-block;
        padding: 0 0 0 0px;
    }`);
style.sheet.insertRule(`
    /* Help Button Styles */
    #meshcat-help-button {
        position: absolute; /* Position relative to parent */
        bottom: 10px;
        right: 10px;
        width: 28px; /* Slightly larger */
        height: 28px; /* Slightly larger */
        background-color: rgba(40, 40, 40, 0.7); /* Darker, more opaque */
        color: #ddd; /* Lighter gray */
        border: 1px solid #555;
        border-radius: 50%;
        text-align: center;
        font-size: 18px; /* Slightly larger font */
        font-weight: bold;
        line-height: 26px; /* Adjust for new size and border */
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; /* Change font */
        cursor: pointer;
        z-index: 9999; /* Increase z-index significantly */
        user-select: none; /* Prevent text selection */
        transition: background-color 0.2s ease; /* Smooth hover transition */
    }`);
style.sheet.insertRule(`
    #meshcat-help-button:hover {
        background-color: rgba(157, 157, 157, 0.74); /* Slightly lighter on hover */
        color: #fff;
    }`);
style.sheet.insertRule(`
    /* Help Panel Styles */
    #meshcat-help-panel {
        position: absolute;
        bottom: 45px; /* Position above the button */
        right: 10px;
        background-color: rgba(60, 60, 60, 0.5); /* Dark gray, less opaque */
        color: #eee;
        border: 1px solid #444;
        border-radius: 15px;
        padding: 25px 25px;
        font-family: monospace;
        font-size: 12px;
        line-height: 1.4;
        z-index: 9998; /* Increase panel z-index (below button) */
        display: none; /* Hidden by default */
        white-space: pre; /* Preserve whitespace and line breaks */
    }`);
style.sheet.insertRule(`
    #meshcat-help-panel.help-panel-visible {
        display: block; /* Show when class is added */
    }`);
style.sheet.insertRule(`
    /* Style for active status messages */
    .status-message-active {
        background-color: rgba(0, 0, 0, 0.7) !important; /* Semi-transparent black */
        color: #eee !important; /* Ensure text is visible */
        padding: 2px 4px !important;
        border-radius: 3px !important;
        margin-top: 2px !important; /* Add tiny space above */
        display: inline-block !important; /* Prevent full width block */
    }`);

export { Viewer, THREE };

