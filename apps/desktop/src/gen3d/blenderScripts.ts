// Aha's fixed headless Blender scripts for 3D generation. They take a schema-checked JSON
// config, never AI source, and run as `blender -b --python <script> -- <config.json>`.
// Kept as strings so the desktop bundle ships them without extra resource files.

export const GEN3D_PROCESS_SCRIPT = String.raw`# Aha 3D generation fixed optimization script (headless Blender). Never runs AI source.
# Usage: blender -b --factory-startup --disable-autoexec --python process.py -- config.json
import bpy, bmesh, json, math, os, sys, time
from mathutils import Matrix, Vector

started = time.time()
with open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8') as handle:
    cfg = json.load(handle)
out = cfg['output']
params = cfg['process']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0


def select_only(objects, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objects[-1]


def triangles(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def duplicate(obj, name):
    copy = obj.copy()
    copy.data = obj.data.copy()
    copy.name = name
    scene.collection.objects.link(copy)
    return copy


def clean(obj):
    # Collapsing can leave zero-area faces whose normals are zero; glTF validation rejects them.
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-7)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() <= 1e-12], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def decimate(obj, ratio):
    if ratio < 1:
        select_only([obj])
        modifier = obj.modifiers.new('Decimate', 'DECIMATE')
        modifier.ratio = max(ratio, 0.0001)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    clean(obj)


def export(objects, name, extras=False):
    select_only(objects)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(out, name), export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_tangents=True, export_animations=False,
        export_cameras=False, export_lights=False, export_extras=extras)


def project_reference(target):
    """Paints the three-view reference onto the low poly's UVs, using the same alignment as the
    blueprint score: shared px/m scale, ground line, per-view centring, registered shift and
    mirror. Hidden texels (ray test against the high poly) keep the baked material colour."""
    import numpy as np
    from mathutils.bvhtree import BVHTree
    cfg_p = cfg['projection']
    W, GROUND = 256, round(256 * 0.95)
    res = min(size, 1024)
    lo_c = Vector(map(min, *[Vector(c) for c in high.bound_box]))
    hi_c = Vector(map(max, *[Vector(c) for c in high.bound_box]))
    extent = hi_c - lo_c
    extent = Vector([max(v, 1e-6) for v in extent])

    def bake_attribute(socket):
        image = bpy.data.images.new('aha_' + socket, res, res, alpha=True, float_buffer=True)
        image.colorspace_settings.name = 'Non-Color'
        image.generated_color = (0, 0, 0, 0)
        temp = bpy.data.materials.new('aha_' + socket)
        temp.use_nodes = True
        tree = temp.node_tree
        tree.nodes.clear()
        output = tree.nodes.new('ShaderNodeOutputMaterial')
        geometry = tree.nodes.new('ShaderNodeNewGeometry')
        value = geometry.outputs[socket]
        # Emission must stay in 0..1: positions are normalised to the bounds, normals to n/2+1/2.
        if socket == 'Position':
            sub = tree.nodes.new('ShaderNodeVectorMath'); sub.operation = 'SUBTRACT'
            sub.inputs[1].default_value = lo_c
            div = tree.nodes.new('ShaderNodeVectorMath'); div.operation = 'DIVIDE'
            div.inputs[1].default_value = extent
            tree.links.new(value, sub.inputs[0]); tree.links.new(sub.outputs[0], div.inputs[0])
            value = div.outputs[0]
        else:
            mul = tree.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY_ADD'
            mul.inputs[1].default_value = (0.5, 0.5, 0.5); mul.inputs[2].default_value = (0.5, 0.5, 0.5)
            tree.links.new(value, mul.inputs[0])
            value = mul.outputs[0]
        emission = tree.nodes.new('ShaderNodeEmission')
        tree.links.new(value, emission.inputs['Color'])
        tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])
        node = tree.nodes.new('ShaderNodeTexImage'); node.image = image
        tree.nodes.active = node
        saved = list(low.data.materials)
        low.data.materials.clear(); low.data.materials.append(temp)
        select_only([low])
        bpy.ops.object.bake(type='EMIT', use_selected_to_active=False, margin=0)
        low.data.materials.clear()
        for m in saved:
            low.data.materials.append(m)
        data = np.empty(res * res * 4, np.float32)
        image.pixels.foreach_get(data)
        bpy.data.images.remove(image); bpy.data.materials.remove(temp)
        return data.reshape(res, res, 4)

    pos = bake_attribute('Position')
    nor = bake_attribute('Normal')
    covered = pos[..., 3] > 0.5
    P = pos[..., :3] * np.array(extent) + np.array(lo_c)
    N = nor[..., :3] * 2 - 1
    N /= np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-6)

    reference = bpy.data.images.load(cfg_p['reference'])
    rw, rh = reference.size
    ref = np.empty(rw * rh * 4, np.float32); reference.pixels.foreach_get(ref)
    ref = ref.reshape(rh, rw, 4)[::-1]  # Blender rows start at the bottom; flip to image rows.
    boxes = cfg_p['boxes']
    tallest = max(b['y1'] - b['y0'] + 1 for b in boxes.values())
    widest = max(b['x1'] - b['x0'] + 1 for b in boxes.values())
    scale = min(256 * 0.9 / tallest, 256 * 0.92 / widest)
    masks = {}
    for view, file in cfg_p['masks'].items():
        m = bpy.data.images.load(file)
        data = np.empty(W * W * 4, np.float32); m.pixels.foreach_get(data)
        masks[view] = data.reshape(W, W, 4)[::-1][..., 0] > 0.5

    verts = np.array([v.co[:] for v in high.data.vertices])
    gx, gy, gz = verts[:, 0], verts[:, 2], -verts[:, 1]
    y0 = gy.min()
    ppm = cfg_p['pxPerMetre']
    # (reference view, to-camera direction in Blender, u per glTF vertex, mirror flip)
    views = [
        ('front', Vector((0, -1, 0)), lambda x, y, z: x, False),
        ('back', Vector((0, 1, 0)), lambda x, y, z: -x, False),
        ('side', Vector((1, 0, 0)), lambda x, y, z: -z, False),
        ('side', Vector((-1, 0, 0)), lambda x, y, z: z, True),
    ]
    tree = BVHTree.FromObject(high, bpy.context.evaluated_depsgraph_get())
    eps = 0.002 * extent.length
    accum = np.zeros((res, res, 3), np.float32)
    weight = np.zeros((res, res), np.float32)
    PX, PY, PZ = P[..., 0], P[..., 2], -P[..., 1]  # glTF coordinates of every texel
    for view, direction, u_of, flip in views:
        reg = cfg_p['views'][view]
        mirrored = reg['mirrored'] != flip
        u_verts = u_of(gx, gy, gz)
        cx = (u_verts.min() + u_verts.max()) / 2
        facing = (N @ np.array(direction)).astype(np.float32)
        candidate = covered & (facing > 0.15)
        bx = W / 2 + (u_of(PX, PY, PZ) - cx) * ppm
        x = (W - bx if mirrored else bx) + reg['dx']
        y = GROUND - (PY - y0) * ppm
        xi = np.clip(x.astype(int), 0, W - 1); yi = np.clip(y.astype(int), 0, W - 1)
        candidate &= masks[view][yi, xi]
        box = boxes[view]
        sx = (box['x0'] + box['x1']) / 2 + (x - W / 2) / scale
        sy = box['y1'] - (GROUND - y) / scale
        sxi = np.clip(sx.astype(int), 0, rw - 1); syi = np.clip(sy.astype(int), 0, rh - 1)
        # Hidden texels: anything of the high poly between the texel and the viewer.
        rows, cols = np.nonzero(candidate)
        visible = np.zeros(len(rows), bool)
        for i, (r, c) in enumerate(zip(rows, cols)):
            origin = Vector(P[r, c]) + Vector(N[r, c]) * eps
            visible[i] = tree.ray_cast(origin, direction)[0] is None
        rows, cols = rows[visible], cols[visible]
        w = facing[rows, cols] ** 2
        accum[rows, cols] += ref[syi[rows, cols], sxi[rows, cols], :3] * w[:, None]
        weight[rows, cols] += w
    painted = weight > 1e-4
    color = np.where(painted[..., None], accum / np.maximum(weight, 1e-6)[..., None], 0)
    alpha = np.clip(weight / 0.25, 0, 1)
    # Dilate across island borders so the bake margin does not show the fallback colour.
    for _ in range(8):
        grow = (alpha == 0)
        if not grow.any():
            break
        total = np.zeros_like(color); count = np.zeros(alpha.shape, np.float32); amax = np.zeros_like(alpha)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            shifted_a = np.roll(np.roll(alpha, dy, 0), dx, 1)
            shifted_c = np.roll(np.roll(color, dy, 0), dx, 1)
            has = shifted_a > 0
            total += shifted_c * has[..., None]; count += has; amax = np.maximum(amax, shifted_a)
        fill = grow & (count > 0) & ~covered
        color[fill] = total[fill] / count[fill][:, None]
        alpha[fill] = amax[fill]
    factor = size // res
    if factor > 1:
        color = color.repeat(factor, 0).repeat(factor, 1)
        alpha = alpha.repeat(factor, 0).repeat(factor, 1)
    base = np.empty(size * size * 4, np.float32); target.pixels.foreach_get(base)
    base = base.reshape(size, size, 4)
    a = alpha[..., None]
    base[..., :3] = base[..., :3] * (1 - a) + color * a
    target.pixels.foreach_set(base.ravel())
    target.update()
    target.pack()
    stats['projectedPct'] = round(100 * float(painted.sum()) / max(1, int(covered.sum())), 1)


# Procedural PBR presets Aha builds itself; the bake turns them into standard texture maps.
# (preset: base roughness, metalness, bump strength, detail in features per metre)
PRESETS = {
    'wood': (0.62, 0.0, 0.25, 9.0),
    'metal': (0.32, 1.0, 0.05, 40.0),
    'painted-metal': (0.5, 0.0, 0.08, 14.0),
    'gold': (0.25, 1.0, 0.03, 30.0),
    'stone': (0.88, 0.0, 0.45, 10.0),
    'fabric': (0.92, 0.0, 0.18, 160.0),
    'leather': (0.55, 0.0, 0.2, 70.0),
    'plastic': (0.38, 0.0, 0.02, 20.0),
}


def apply_preset(material, preset, color):
    rough, metal, bump_strength, density = PRESETS[preset]
    tree = material.node_tree
    nodes, links = tree.nodes, tree.links
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        return False
    base = bsdf.inputs['Base Color']
    if color:
        value = color.lstrip('#')
        rgb = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        tint = tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb) + (1.0,)
    else:
        tint = tuple(base.default_value)
    for socket in ('Base Color', 'Roughness', 'Metallic', 'Normal'):
        for link in list(bsdf.inputs[socket].links):
            links.remove(link)
    coords = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (density, density, density)
    links.new(coords.outputs['Object'], mapping.inputs['Vector'])
    vec = mapping.outputs['Vector']

    def noise(scale, detail=6.0, rough_=0.55, source=None):
        n = nodes.new('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough_
        links.new(source or vec, n.inputs['Vector'])
        return n.outputs['Fac']

    def ramp(fac, a, b):
        r = nodes.new('ShaderNodeValToRGB')
        r.color_ramp.elements[0].color = a
        r.color_ramp.elements[1].color = b
        links.new(fac, r.inputs['Fac'])
        return r.outputs['Color']

    def shade(c, k):
        return tuple(min(1.0, v * k) for v in c[:3]) + (1.0,)

    def mix_value(a, b, fac):
        m = nodes.new('ShaderNodeMapRange')
        m.inputs['To Min'].default_value = a
        m.inputs['To Max'].default_value = b
        links.new(fac, m.inputs['Value'])
        return m.outputs['Result']

    if preset == 'wood':
        # Growth rings: bands along one axis, warped by noise, plus fine grain.
        wave = nodes.new('ShaderNodeTexWave')
        wave.wave_type = 'BANDS'; wave.bands_direction = 'X'
        wave.inputs['Scale'].default_value = 1.0
        wave.inputs['Distortion'].default_value = 6.0
        wave.inputs['Detail'].default_value = 3.0
        links.new(vec, wave.inputs['Vector'])
        pattern = wave.outputs['Fac']
    elif preset == 'stone':
        cells = nodes.new('ShaderNodeTexVoronoi')
        cells.inputs['Scale'].default_value = 1.0
        links.new(vec, cells.inputs['Vector'])
        mix = nodes.new('ShaderNodeMath'); mix.operation = 'MULTIPLY_ADD'
        links.new(cells.outputs['Distance'], mix.inputs[0]); mix.inputs[1].default_value = 0.6
        links.new(noise(3.0), mix.inputs[2])
        pattern = mix.outputs[0]
    elif preset == 'leather':
        cells = nodes.new('ShaderNodeTexVoronoi')
        cells.inputs['Scale'].default_value = 1.0
        links.new(vec, cells.inputs['Vector'])
        pattern = cells.outputs['Distance']
    elif preset == 'fabric':
        weave = nodes.new('ShaderNodeTexWave')
        weave.wave_type = 'BANDS'; weave.bands_direction = 'DIAGONAL'
        weave.inputs['Scale'].default_value = 1.0
        links.new(vec, weave.inputs['Vector'])
        pattern = weave.outputs['Fac']
    elif preset == 'metal':
        # Brushed: noise stretched along one axis.
        stretch = nodes.new('ShaderNodeMapping')
        stretch.inputs['Scale'].default_value = (0.02, 1.0, 1.0)
        links.new(vec, stretch.inputs['Vector'])
        pattern = noise(1.0, 2.0, 0.4, stretch.outputs['Vector'])
    else:
        pattern = noise(1.0)
    links.new(ramp(pattern, shade(tint, 0.72), shade(tint, 1.18)), base)
    links.new(mix_value(rough - 0.08, rough + 0.08, noise(2.0)), bsdf.inputs['Roughness'])
    bsdf.inputs['Metallic'].default_value = metal
    if preset == 'painted-metal':
        # Worn edges expose bare metal: convex edges (pointiness) plus noise.
        geometry = nodes.new('ShaderNodeNewGeometry')
        edge = nodes.new('ShaderNodeMapRange')
        edge.inputs['From Min'].default_value = 0.52
        edge.inputs['From Max'].default_value = 0.6
        links.new(geometry.outputs['Pointiness'], edge.inputs['Value'])
        wear = nodes.new('ShaderNodeMath'); wear.operation = 'MULTIPLY'
        links.new(edge.outputs['Result'], wear.inputs[0]); links.new(noise(1.0), wear.inputs[1])
        mixed = nodes.new('ShaderNodeMix'); mixed.data_type = 'RGBA'
        links.new(wear.outputs[0], mixed.inputs['Factor'])
        links.new(ramp(pattern, shade(tint, 0.85), shade(tint, 1.1)), mixed.inputs['A'])
        mixed.inputs['B'].default_value = (0.55, 0.55, 0.57, 1)
        links.new(mixed.outputs['Result'], base)
        links.new(wear.outputs[0], bsdf.inputs['Metallic'])
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = bump_strength
    # Bump distance in metres: detail stays physically small whatever the object size.
    bump.inputs['Distance'].default_value = 0.004
    links.new(pattern, bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return True


def apply_tiled(material, tile):
    """A seamless image tiled over the surface by box projection in metres; its luminance drives
    bump and roughness, so the bake yields colour, normal and roughness maps from one image."""
    tree = material.node_tree
    nodes, links = tree.nodes, tree.links
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        return False
    for socket in ('Base Color', 'Roughness', 'Metallic', 'Normal'):
        for link in list(bsdf.inputs[socket].links):
            links.remove(link)
    image = bpy.data.images.load(tile['image'])
    image.colorspace_settings.name = 'sRGB'
    coords = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    density = 1.0 / max(float(tile['metres']), 0.01)
    mapping.inputs['Scale'].default_value = (density, density, density)
    links.new(coords.outputs['Object'], mapping.inputs['Vector'])
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = image
    texture.projection = 'BOX'
    texture.projection_blend = 0.25
    texture.extension = 'REPEAT'
    links.new(mapping.outputs['Vector'], texture.inputs['Vector'])
    links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
    gray = nodes.new('ShaderNodeRGBToBW')
    links.new(texture.outputs['Color'], gray.inputs['Color'])
    rough = float(tile.get('roughness', 0.7))
    # Darker grooves read rougher; the range stays near the chosen roughness.
    roughness = nodes.new('ShaderNodeMapRange')
    roughness.inputs['To Min'].default_value = min(1.0, rough + 0.12)
    roughness.inputs['To Max'].default_value = max(0.0, rough - 0.12)
    links.new(gray.outputs['Val'], roughness.inputs['Value'])
    links.new(roughness.outputs['Result'], bsdf.inputs['Roughness'])
    bsdf.inputs['Metallic'].default_value = 0.0
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.35
    bump.inputs['Distance'].default_value = 0.01 * float(tile['metres'])
    links.new(gray.outputs['Val'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return True


stats = {}
# 1. Import the parent version and merge its parts into one high-poly mesh in world space.
bpy.ops.import_scene.gltf(filepath=cfg['input'])
meshes = [o for o in scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError('The model contains no meshes.')
select_only(meshes)
bpy.ops.object.make_single_user(object=True, obdata=True)
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in [o for o in scene.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o)
# Remember which part every face came from, so the low poly can be split back into parts.
part_names = []
for o in meshes:
    # Parts are identified by their stable ahaId (glTF extras); node names may be generic.
    name = o.get('ahaId') or (o.name.rsplit('.', 1)[0] if len(o.name) > 4 and o.name[-4] == '.' and o.name[-3:].isdigit() else o.name)
    if name not in part_names:
        part_names.append(name)
    attribute = o.data.attributes.new('aha_part', 'INT', 'FACE')
    attribute.data.foreach_set('value', [part_names.index(name)] * len(o.data.polygons))
select_only(meshes, meshes[0])
if len(meshes) > 1:
    bpy.ops.object.join()
high = bpy.context.active_object
high.name = 'High'
# Imported custom split normals interpolate to zero length when decimated; let Blender recompute.
select_only([high])
if high.data.has_custom_normals:
    bpy.ops.mesh.customdata_custom_splitnormals_clear()

applied = []
for item in params.get('materials', []):
    for m in high.data.materials:
        if not m or m.get('ahaId', m.name) != item['materialId']:
            continue
        done = apply_tiled(m, item['tile']) if item['preset'] == 'tiled' else apply_preset(m, item['preset'], item.get('color'))
        if done:
            applied.append(item['materialId'])
if applied:
    stats['materials'] = applied

# 2. Repair: weld duplicates, drop loose vertices and edges, make normals consistent.
if params['repair']:
    bm = bmesh.new()
    bm.from_mesh(high.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context='EDGES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(high.data)
    bm.free()
for polygon in high.data.polygons:
    polygon.use_smooth = True
high_tris = triangles(high)

# 3. Low poly at the target triangle count.
low = duplicate(high, 'Model')
decimate(low, params['targetTriangles'] / max(high_tris, 1))
size = int(params['textureSize'])
# Decimation moves the bounds a little; keep the published low poly bottom-centred (Blender Z up).
lo = Vector(map(min, *[Vector(c) for c in low.bound_box]))
hi = Vector(map(max, *[Vector(c) for c in low.bound_box]))
shift = Matrix.Translation(-Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z)))
low.data.transform(shift)
high.data.transform(shift)
corners = [high.matrix_world @ Vector(c) for c in high.bound_box]
diagonal = (Vector(map(max, *corners)) - Vector(map(min, *corners))).length

baked = []
if params['bake']:
    # 4. New UVs, then bake the high poly's surface onto them (selected to active).
    select_only([low])
    while low.data.uv_layers:
        low.data.uv_layers.remove(low.data.uv_layers[0])
    low.data.uv_layers.new(name='UVMap')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=6 / size)
    bpy.ops.object.mode_set(mode='OBJECT')
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 16
    scene.render.bake.margin = max(4, size // 128)
    material = bpy.data.materials.new('Baked')
    material.use_nodes = True
    # The low poly is closed, so it exports single-sided like ordinary game assets.
    material.use_backface_culling = True
    low.data.materials.clear()
    low.data.materials.append(material)
    nodes, links = material.node_tree.nodes, material.node_tree.links
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    high_materials = [m for m in high.data.materials if m and m.use_nodes]

    def bake(kind, label, colorspace, **options):
        image = bpy.data.images.new('aha_' + label, size, size, alpha=False)
        image.colorspace_settings.name = colorspace
        node = nodes.new('ShaderNodeTexImage')
        node.image = image
        nodes.active = node
        select_only([high, low], low)
        bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.01 * diagonal,
                            max_ray_distance=0.04 * diagonal, margin=scene.render.bake.margin, **options)
        image.pack()
        baked.append(label)
        return node

    def channel(node, socket):
        split = nodes.new('ShaderNodeSeparateColor')
        links.new(node.outputs['Color'], split.inputs['Color'])
        links.new(split.outputs['Red'], socket)

    # Cycles' diffuse colour pass is scaled by (1 - metallic), which turns metal black. Route
    # each material's Base Color and Metallic inputs to an emission shader and bake that instead.
    def principled_source(m, name):
        principled = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if not principled:
            return None, None
        socket = principled.inputs[name]
        return (socket.links[0].from_socket if socket.links else None), socket.default_value

    def bake_emitted(name, label, colorspace, fallback):
        restore = []
        for m in high_materials:
            tree = m.node_tree
            output = next((n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
            if not output:
                continue
            link, value = principled_source(m, name)
            previous = output.inputs['Surface'].links[0].from_socket if output.inputs['Surface'].links else None
            emission = tree.nodes.new('ShaderNodeEmission')
            if value is None:
                emission.inputs['Color'].default_value = fallback
            elif isinstance(value, float):
                emission.inputs['Color'].default_value = (value, value, value, 1)
            else:
                emission.inputs['Color'].default_value = tuple(value)
            if link:
                tree.links.new(link, emission.inputs['Color'])
            tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])
            restore.append((tree, output, previous, emission))
        node = bake('EMIT', label, colorspace)
        for tree, output, previous, emission in restore:
            tree.nodes.remove(emission)
            if previous:
                tree.links.new(previous, output.inputs['Surface'])
        return node

    color = bake_emitted('Base Color', 'baseColor', 'sRGB', (0.8, 0.8, 0.8, 1))
    links.new(color.outputs['Color'], bsdf.inputs['Base Color'])
    if params.get('texture') == 'projection':
        project_reference(color.image)
    channel(bake('ROUGHNESS', 'roughness', 'Non-Color'), bsdf.inputs['Roughness'])
    metals = [principled_source(m, 'Metallic') for m in high_materials]
    if any(link or (value or 0) > 0 for link, value in metals):
        channel(bake_emitted('Metallic', 'metallic', 'Non-Color', (0, 0, 0, 1)), bsdf.inputs['Metallic'])
    else:
        bsdf.inputs['Metallic'].default_value = 0.0

    normal = bake('NORMAL', 'normal', 'Non-Color', normal_space='TANGENT')
    normal_map = nodes.new('ShaderNodeNormalMap')
    links.new(normal.outputs['Color'], normal_map.inputs['Color'])
    links.new(normal_map.outputs['Normal'], bsdf.inputs['Normal'])
    scene.cycles.samples = 32
    ao = bake('AO', 'occlusion', 'Non-Color')
    # The glTF exporter reads ambient occlusion from this custom group's Occlusion socket.
    group = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    group.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    group_node = nodes.new('ShaderNodeGroup')
    group_node.node_tree = group
    channel(ao, group_node.inputs['Occlusion'])

# 5. Levels of detail from the low poly; they share its UVs and material.
lods = []
for index, ratio in enumerate(params['lods'], start=1):
    lod = duplicate(low, 'Model_LOD%d' % index)
    decimate(lod, ratio)
    name = 'lod%d.glb' % index
    export([lod], name)
    lods.append({'file': name, 'triangles': triangles(lod)})
    bpy.data.objects.remove(lod)

# 6. Collision: bounding box or convex hull, without materials.
collision = None
if params['collision'] != 'none':
    mesh = bpy.data.meshes.new('Collision')
    bm = bmesh.new()
    if params['collision'] == 'box':
        lo = Vector(map(min, *corners))
        hi = Vector(map(max, *corners))
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector(lo[i] + (v.co[i] + 0.5) * (hi[i] - lo[i]) for i in range(3))
    else:
        for v in low.data.vertices:
            bm.verts.new(low.matrix_world @ v.co)
        bmesh.ops.convex_hull(bm, input=bm.verts)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(mesh)
    bm.free()
    shape = bpy.data.objects.new('Collision', mesh)
    scene.collection.objects.link(shape)
    if params['collision'] == 'convex':
        decimate(shape, 250 / max(triangles(shape), 1))
    export([shape], 'collision.glb')
    collision = {'file': 'collision.glb', 'triangles': triangles(shape)}

bpy.data.objects.remove(high)
final = [low]
if params.get('keepParts') and len(part_names) > 1 and 'aha_part' in low.data.attributes:
    # One object per source part, sharing the low poly's UVs and baked material.
    import numpy as np
    values = np.empty(len(low.data.polygons), np.int32)
    low.data.attributes['aha_part'].data.foreach_get('value', values)
    final = []
    for index, name in enumerate(part_names):
        if not (values == index).any():
            continue  # decimated away
        part = duplicate(low, name)
        part.data.name = name
        part['ahaId'] = name
        bm = bmesh.new()
        bm.from_mesh(part.data)
        layer = bm.faces.layers.int.get('aha_part')
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[layer] != index], context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        bm.to_mesh(part.data)
        bm.free()
        final.append(part)
    bpy.data.objects.remove(low)
    stats['parts'] = len(final)
for o in final:
    if 'aha_part' in o.data.attributes:
        o.data.attributes.remove(o.data.attributes['aha_part'])
# Kept parts carry their ahaId so the inspection report and prop animation see the same ids.
export(final, 'model.glb', extras=len(final) > 1)
report = {'highTriangles': high_tris, 'lowTriangles': sum(triangles(o) for o in final), 'lods': lods, 'collision': collision,
          'baked': baked, 'textureSize': size, 'seconds': round(time.time() - started, 2), **stats}
with open(os.path.join(out, 'process.json'), 'w', encoding='utf-8') as handle:
    json.dump(report, handle)
print('AHA_PROCESS=' + json.dumps(report))
`;

export const GEN3D_CONVERT_SCRIPT = String.raw`# Aha 3D generation fixed export conversion (headless Blender). Never runs AI source.
# Usage: blender -b --factory-startup --disable-autoexec --python convert.py -- config.json
import bpy, bmesh, json, os, sys

with open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8') as handle:
    cfg = json.load(handle)
out, name, fmt, preset = cfg['output'], cfg['name'], cfg['format'], cfg['preset']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0


def load(file, label):
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=file)
    added = [o for o in scene.objects if o not in before]
    meshes = [o for o in added if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in added:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for o in [o for o in added if o.type != 'MESH']:
        bpy.data.objects.remove(o)
    if len(meshes) > 1:
        bpy.ops.object.select_all(action='DESELECT')
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = label
    obj.data.name = label
    return obj


def load_rigged(file):
    """An animated asset keeps its clips. Rigged: the armature and skinned mesh (the importer's
    bone display shapes go). Props: every part and the animated pivot, as authored."""
    scene.render.fps = 30
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=file)
    added = [o for o in scene.objects if o not in before]
    rig = next((o for o in added if o.type == 'ARMATURE'), None)
    if rig is None:
        return next(o for o in added if o.type == 'MESH')
    skinned = next(o for o in added if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers))
    for bone in rig.pose.bones:
        bone.custom_shape = None
    for o in added:
        if o not in (rig, skinned):
            bpy.data.objects.remove(o)
    rig.name = name + '_Rig'
    skinned.name = skinned.data.name = name
    return skinned


rigged = bool(cfg.get('rigged'))
if rigged:
    model = load_rigged(cfg['input'])
    lods = []
else:
    model = load(cfg['input'], name if fmt != 'fbx' else name + '_LOD0')
    lods = [load(file, '%s_LOD%d' % (name, i)) for i, file in enumerate(cfg['lods'], start=1)] if fmt == 'fbx' else []
# LODs share the low poly's UVs, so they reuse its material instead of a copy of every texture.
for lod in lods:
    lod.data.materials.clear()
    for material in model.data.materials:
        lod.data.materials.append(material)
bpy.ops.outliner.orphans_purge(do_recursive=True)
# Engine naming conventions turn the hull into a collider on import.
collider_names = {'unreal': 'UCX_%s_00' % name, 'unity': '%s_Collider' % name,
                  'godot': '%s-%s' % (name, 'convcolonly' if cfg.get('collisionKind') == 'convex' else 'colonly')}
collision = None
if cfg.get('collision') and (fmt == 'fbx' or preset == 'godot'):
    collision = load(cfg['collision'], collider_names.get(preset, name + '_Collision'))
    collision.data.materials.clear()

# Formats with external textures get real PNG files next to the model.
if fmt in ('fbx', 'obj'):
    os.makedirs(os.path.join(out, 'textures'), exist_ok=True)
    for image in bpy.data.images:
        if image.packed_file:
            file = os.path.join(out, 'textures', bpy.path.clean_name(image.name) + '.png')
            image.filepath_raw = file
            image.file_format = 'PNG'
            image.save()
            image.unpack(method='REMOVE')
            image.filepath = file

report = {'format': fmt, 'preset': preset, 'files': []}
if fmt == 'glb':
    bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'model.glb'), export_format='GLB', export_yup=True,
                              export_apply=not rigged, export_tangents=True, export_animations=rigged,
                              export_animation_mode='ACTIONS', export_skins=rigged, export_def_bones=False)
    report['files'].append('model.glb')
elif fmt == 'fbx':
    # One consistent axis header for every engine: Unity reads it as is, and Unreal's importer
    # converts it to Z up and centimetres. Re-axing the data here would disagree with the header.
    bpy.ops.export_scene.fbx(filepath=os.path.join(out, name + '.fbx'), path_mode='RELATIVE', embed_textures=False,
                             axis_forward='-Z', axis_up='Y', apply_unit_scale=True,
                             apply_scale_options='FBX_SCALE_UNITS', bake_space_transform=True,
                             add_leaf_bones=False, mesh_smooth_type='FACE', use_tspace=True, bake_anim=rigged,
                             bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False,
                             bake_anim_use_all_bones=True, bake_anim_force_startend_keying=True,
                             bake_anim_simplify_factor=0.0)
    report['files'].append(name + '.fbx')
elif fmt == 'obj':
    bpy.ops.wm.obj_export(filepath=os.path.join(out, name + '.obj'), export_materials=True, path_mode='RELATIVE',
                          export_triangulated_mesh=True, forward_axis='NEGATIVE_Z', up_axis='Y')
    report['files'] += [name + '.obj', name + '.mtl']
elif fmt == 'usdz':
    bpy.ops.wm.usd_export(filepath=os.path.join(out, name + '.usdz'), export_materials=True,
                          export_textures_mode='NEW', relative_paths=True)
    report['files'].append(name + '.usdz')
elif fmt == 'stl':
    bm = bmesh.new()
    bm.from_mesh(model.data)
    # glTF splits vertices along UV and normal seams; weld them before judging closure.
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    open_edges = sum(1 for e in bm.edges if not e.is_manifold)
    bm.free()
    report['watertight'] = open_edges == 0
    report['openEdges'] = open_edges
    bpy.ops.wm.stl_export(filepath=os.path.join(out, name + '.stl'), ascii_format=False, forward_axis='Y', up_axis='Z')
    report['files'].append(name + '.stl')
if os.path.isdir(os.path.join(out, 'textures')):
    report['files'] += ['textures/' + f for f in sorted(os.listdir(os.path.join(out, 'textures')))]
print('AHA_CONVERT=' + json.dumps(report))
`;

export const GEN3D_TEXTURE_SCRIPT = String.raw`# Aha 3D generation fixed texture script (headless Blender). Never runs AI source.
# Usage: blender -b --factory-startup --disable-autoexec --python texture.py -- config.json
# mode "view": renders one orthographic view of a baked version for mask painting.
# mode "repaint": projects an edited view image back onto the base colour texture inside the mask.
import bpy, json, math, os, sys, time
import numpy as np
from mathutils import Matrix, Vector

started = time.time()
with open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8') as handle:
    cfg = json.load(handle)
out = cfg['output']
R = int(cfg.get('resolution', 1024))
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# View directions point from the model to the camera, in glTF axes (Y up, +Z front), with the
# image's up vector. Names follow Blender's numpad views.
S2 = 1 / math.sqrt(2)
VIEWS = {
    'front': ((0, 0, 1), (0, 1, 0)),
    'back': ((0, 0, -1), (0, 1, 0)),
    'right': ((1, 0, 0), (0, 1, 0)),
    'left': ((-1, 0, 0), (0, 1, 0)),
    'front-right': ((S2, 0, S2), (0, 1, 0)),
    'front-left': ((-S2, 0, S2), (0, 1, 0)),
    'top': ((0, 1, 0), (0, 0, -1)),
}


def blender(v):
    return Vector((v[0], -v[2], v[1]))


def load_model(file):
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=file)
    meshes = [o for o in scene.objects if o not in before and o.type == 'MESH']
    if not meshes:
        raise RuntimeError('The version has no mesh.')
    # Versions optimized with separate parts share one baked material; join them to render.
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    material = obj.data.materials[0] if obj.data.materials else None
    bsdf = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if material else None
    link = bsdf.inputs['Base Color'].links[0] if bsdf and bsdf.inputs['Base Color'].links else None
    if not link or link.from_node.type != 'TEX_IMAGE':
        raise RuntimeError('The version has no baked base colour texture.')
    return obj, material, link.from_node


obj, material, color_node = load_model(cfg['input'])
texture = color_node.image
depsgraph = bpy.context.evaluated_depsgraph_get()
world = [obj.matrix_world @ v.co for v in obj.data.vertices]
G = np.array([(v.x, v.z, -v.y) for v in world])  # glTF coordinates
lo_g, hi_g = G.min(0), G.max(0)
extent = np.maximum(hi_g - lo_g, 1e-6)

d = np.array(VIEWS[cfg['view']][0], float)
up = np.array(VIEWS[cfg['view']][1], float)
right = np.cross(up, d)
u, v = G @ right, G @ up
cu, cv = (u.min() + u.max()) / 2, (v.min() + v.max()) / 2
frame = max(u.max() - u.min(), v.max() - v.min()) * 1.1
depth_mid = (G @ d).mean()
centre = right * cu + up * cv + d * depth_mid
# Light from the camera's upper left; the same factor is removed again before projecting back.
L = d + 0.6 * up - 0.4 * right
L /= np.linalg.norm(L)


def to_pixels(points):
    """glTF points -> image x (right) and y (down) in pixels."""
    x = ((points @ right - cu) / frame + 0.5) * R
    y = (0.5 - (points @ up - cv) / frame) * R
    return x, y


def emit_tree(m, socket_from):
    """Routes a value to an emission shader; returns a restore callback."""
    tree = m.node_tree
    output = next(n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
    previous = output.inputs['Surface'].links[0].from_socket if output.inputs['Surface'].links else None
    emission = tree.nodes.new('ShaderNodeEmission')
    tree.links.new(socket_from(tree), emission.inputs['Color'])
    tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])

    def restore():
        tree.nodes.remove(emission)
        if previous:
            tree.links.new(previous, output.inputs['Surface'])
    return restore


def setup_camera():
    cam_data = bpy.data.cameras.new('AhaView')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = frame
    cam_data.clip_start = 0.001
    cam_data.clip_end = 1000
    cam = bpy.data.objects.new('AhaView', cam_data)
    scene.collection.objects.link(cam)
    distance = float(np.linalg.norm(extent)) * 2 + 1
    rotation = Matrix((blender(right), blender(up), blender(d))).transposed()
    cam.matrix_world = Matrix.Translation(blender(centre + d * distance)) @ rotation.to_4x4()
    scene.camera = cam
    render = scene.render
    render.resolution_x = render.resolution_y = R
    render.resolution_percentage = 100
    render.film_transparent = True
    render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.max_bounces = 0
    scene.cycles.use_denoising = False
    scene.cycles.seed = 0
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1


def render_pass(name, socket_from, samples, filter_width):
    """Renders an emission pass to linear float RGBA, rows from the top."""
    restore = emit_tree(material, socket_from)
    scene.cycles.samples = samples
    scene.cycles.filter_width = filter_width
    settings = scene.render.image_settings
    settings.file_format = 'OPEN_EXR'
    settings.color_depth = '32'
    settings.color_mode = 'RGBA'
    path = os.path.join(out, 'aha-%s.exr' % name)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    restore()
    image = bpy.data.images.load(path)
    image.colorspace_settings.name = 'Non-Color'
    data = np.empty(R * R * 4, np.float32)
    image.pixels.foreach_get(data)
    bpy.data.images.remove(image)
    os.remove(path)
    return data.reshape(R, R, 4)[::-1]


lo_b = Vector(map(min, *[Vector(c) for c in world]))
hi_b = Vector(map(max, *[Vector(c) for c in world]))
size_b = Vector([max(x, 1e-6) for x in hi_b - lo_b])


def position_socket(tree):
    geometry = tree.nodes.new('ShaderNodeNewGeometry')
    sub = tree.nodes.new('ShaderNodeVectorMath'); sub.operation = 'SUBTRACT'
    sub.inputs[1].default_value = lo_b
    div = tree.nodes.new('ShaderNodeVectorMath'); div.operation = 'DIVIDE'
    div.inputs[1].default_value = size_b
    tree.links.new(geometry.outputs['Position'], sub.inputs[0])
    tree.links.new(sub.outputs[0], div.inputs[0])
    return div.outputs[0]


def normal_socket(tree):
    geometry = tree.nodes.new('ShaderNodeNewGeometry')
    mul = tree.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY_ADD'
    mul.inputs[1].default_value = (0.5, 0.5, 0.5); mul.inputs[2].default_value = (0.5, 0.5, 0.5)
    tree.links.new(geometry.outputs['Normal'], mul.inputs[0])
    return mul.outputs[0]


def decode_position(p):
    """Normalised Blender position -> glTF coordinates."""
    b = p * np.array(size_b) + np.array(lo_b)
    return np.stack([b[..., 0], b[..., 2], -b[..., 1]], -1)


def decode_normal(n):
    b = n * 2 - 1
    g = np.stack([b[..., 0], b[..., 2], -b[..., 1]], -1)
    return g / np.maximum(np.linalg.norm(g, axis=-1, keepdims=True), 1e-6)


def shading(normals):
    return 0.6 + 0.4 * np.clip(normals @ L, 0, 1)


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def save_png(rgb, alpha, file):
    image = bpy.data.images.new('aha_out', rgb.shape[1], rgb.shape[0], alpha=alpha is not None)
    data = np.ones((rgb.shape[0], rgb.shape[1], 4), np.float32)
    data[..., :3] = rgb
    if alpha is not None:
        data[..., 3] = alpha
    image.pixels.foreach_set(data[::-1].ravel())
    image.filepath_raw = file
    image.file_format = 'PNG'
    image.save()
    bpy.data.images.remove(image)


setup_camera()
pos = render_pass('position', position_socket, 1, 0.01)
nor = render_pass('normal', normal_socket, 1, 0.01)
hit = pos[..., 3] > 0.5
view_normal = decode_normal(nor[..., :3])
view_shade = shading(view_normal)

if cfg['mode'] == 'view':
    color_link = lambda tree: color_node.outputs['Color']
    color = render_pass('color', color_link, 16, 1.5)
    alpha = np.clip(color[..., 3], 0, 1)
    # The emission pass holds linear albedo; shade it so the image model reads the form.
    lit = color[..., :3] / np.maximum(alpha, 1e-6)[..., None]
    shade = np.where(hit, view_shade, 1.0)[..., None]
    rgb = linear_to_srgb(lit * shade)
    background = 0.5
    rgb = rgb * alpha[..., None] + background * (1 - alpha[..., None])
    save_png(rgb, None, cfg.get('file') or os.path.join(out, 'view.png'))
    report = {'view': cfg['view'], 'resolution': R, 'coverage': round(float(hit.mean()) * 100, 1),
              'seconds': round(time.time() - started, 2)}
    print('AHA_TEXTURE=' + json.dumps(report))
    sys.exit(0)

# ---- repaint ----
size = texture.size[0]
res = min(size, 2048)


def bake_attribute(socket_from):
    image = bpy.data.images.new('aha_bake', res, res, alpha=True, float_buffer=True)
    image.colorspace_settings.name = 'Non-Color'
    image.generated_color = (0, 0, 0, 0)
    restore = emit_tree(material, socket_from)
    tree = material.node_tree
    node = tree.nodes.new('ShaderNodeTexImage'); node.image = image
    tree.nodes.active = node
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type='EMIT', use_selected_to_active=False, margin=0)
    tree.nodes.remove(node)
    restore()
    data = np.empty(res * res * 4, np.float32)
    image.pixels.foreach_get(data)
    bpy.data.images.remove(image)
    return data.reshape(res, res, 4)  # texture rows bottom-up, like Blender's pixel buffer


scene.cycles.samples = 1
tex_pos = bake_attribute(position_socket)
tex_nor = bake_attribute(normal_socket)
covered = tex_pos[..., 3] > 0.5
P = decode_position(tex_pos[..., :3])
N = decode_normal(tex_nor[..., :3])
view_pos = decode_position(pos[..., :3])


def load_rgba(file):
    image = bpy.data.images.load(file)
    w, h = image.size
    if (w, h) != (R, R):
        raise RuntimeError('Image size %dx%d does not match the %d px view.' % (w, h, R))
    data = np.empty(w * h * 4, np.float32)
    image.pixels.foreach_get(data)
    bpy.data.images.remove(image)
    return data.reshape(h, w, 4)[::-1]


edited = load_rgba(cfg['image'])
# The mask follows the image-edit convention: transparent pixels are the area to repaint.
mask = (1 - load_rgba(cfg['mask'])[..., 3] > 0.5).astype(np.float32)
mask_pixels = int(mask.sum())


def blur(a, radius):
    """Box blur three times (close to Gaussian), keeping zero outside the image."""
    for _ in range(3):
        for axis in (0, 1):
            pad = [(radius + 1, radius), (0, 0)] if axis == 0 else [(0, 0), (radius + 1, radius)]
            c = np.cumsum(np.pad(a, pad), axis)
            a = (np.take(c, range(2 * radius + 1, c.shape[axis]), axis) - np.take(c, range(0, c.shape[axis] - 2 * radius - 1), axis)) / (2 * radius + 1)
    return a


feather = int(cfg.get('feather', 6))
# Feather only inward so nothing outside the painted mask can change.
weight_map = np.clip(blur(mask, feather) * 2 - 1, 0, 1) * mask if feather else mask


def sample(img, x, y):
    """Bilinear sample of an HxWxC image at pixel coordinates (pixel centres at +0.5)."""
    x = np.clip(x - 0.5, 0, R - 1.001); y = np.clip(y - 0.5, 0, R - 1.001)
    x0 = x.astype(int); y0 = y.astype(int); fx = x - x0; fy = y - y0
    if img.ndim == 2:
        img = img[..., None]
    a = img[y0, x0] * ((1 - fx) * (1 - fy))[:, None] + img[y0, x0 + 1] * (fx * (1 - fy))[:, None]
    b = img[y0 + 1, x0] * ((1 - fx) * fy)[:, None] + img[y0 + 1, x0 + 1] * (fx * fy)[:, None]
    return a + b


rows, cols = np.nonzero(covered)
p, n = P[rows, cols], N[rows, cols]
x, y = to_pixels(p)
inside = (x >= 0) & (x < R) & (y >= 0) & (y < R)
facing = n @ d
xi = np.clip(x.astype(int), 0, R - 1); yi = np.clip(y.astype(int), 0, R - 1)
pixel = frame / R
tolerance = 0.01 * float(np.linalg.norm(extent)) + 2 * pixel
# Visible texels: the first surface the camera sees at that pixel is this texel.
visible = inside & hit[yi, xi] & (np.linalg.norm(view_pos[yi, xi] - p, axis=-1) < tolerance) & (facing > 0.05)
grazing = np.clip((facing - 0.05) / 0.3, 0, 1)
w = np.where(visible, sample(weight_map, x, y)[:, 0] * grazing ** 2 * (3 - 2 * grazing), 0)
chosen = w > 1e-3
rows, cols, w, x, y = rows[chosen], cols[chosen], w[chosen], x[chosen], y[chosen]

# The edited image was shaded like the view render; divide that factor out to get albedo.
edit_linear = srgb_to_linear(sample(edited[..., :3], x, y))
shade = sample(view_shade, x, y)[:, 0]
albedo = linear_to_srgb(edit_linear / np.maximum(shade, 0.3)[:, None])

factor = size // res
base = np.empty(size * size * 4, np.float32)
texture.pixels.foreach_get(base)
base = base.reshape(size, size, 4)
original = base.copy()
alpha = np.zeros((res, res), np.float32)
color = np.zeros((res, res, 3), np.float32)
alpha[rows, cols] = w
color[rows, cols] = albedo
# Spread painted colour a few texels into the UV gutter so filtering does not show old seams.
for _ in range(4):
    grow = (alpha == 0) & ~covered
    total = np.zeros_like(color); count = np.zeros(alpha.shape, np.float32); amax = np.zeros_like(alpha)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        sa = np.roll(np.roll(alpha, dy, 0), dx, 1)
        has = sa > 0
        total += np.roll(np.roll(color, dy, 0), dx, 1) * has[..., None]; count += has; amax = np.maximum(amax, sa)
    fill = grow & (count > 0)
    color[fill] = total[fill] / count[fill][:, None]
    alpha[fill] = amax[fill]
if factor > 1:
    color = color.repeat(factor, 0).repeat(factor, 1)
    alpha = alpha.repeat(factor, 0).repeat(factor, 1)
a = alpha[..., None]
blended = base[..., :3] * (1 - a) + color * a
base[..., :3] = np.where(a > 0, blended, base[..., :3])
# Quantise like the 8-bit texture so the change count matches the saved file.
before = np.round(original[..., :3] * 255)
after = np.round(base[..., :3] * 255)
changed = int(np.any(before != after, -1).sum())
save_png(base[::-1, :, :3], None, os.path.join(out, 'baseColor.png'))
report = {'view': cfg['view'], 'textureSize': size, 'maskPixels': mask_pixels,
          'paintedTexels': int(len(rows)), 'changedTexels': changed,
          'seconds': round(time.time() - started, 2)}
print('AHA_TEXTURE=' + json.dumps(report))
`;

export const GEN3D_RIG_SCRIPT = String.raw`# Aha 3D generation fixed rigging script (headless Blender). Never runs AI source.
# Usage: blender -b --factory-startup --disable-autoexec --python rig.py -- config.json
# Builds an armature from the version's skeleton graph, skins the mesh with automatic weights,
# adds procedural animation clips, exports rigged.glb and renders preview frames per clip.
import bpy, json, math, os, sys, time
import numpy as np
from mathutils import Matrix, Vector

started = time.time()
with open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8') as handle:
    cfg = json.load(handle)
out = cfg['output']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
FPS = 30
scene.render.fps = FPS


def blender(p):
    """Aha / glTF point (Y up, +Z front) -> Blender (Z up, -Y front)."""
    return Vector((p[0], -p[2], p[1]))


def select_only(objects, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objects[-1]


# 1. The static mesh, merged into one object like the optimize step.
bpy.ops.import_scene.gltf(filepath=cfg['input'])
meshes = [o for o in scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError('The model contains no meshes.')
select_only(meshes)
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in [o for o in scene.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o)
select_only(meshes, meshes[0])
if len(meshes) > 1:
    bpy.ops.object.join()
body = bpy.context.active_object
body.name = cfg.get('name', 'Model')
# glTF splits vertices along UV seams; heat weighting needs one connected surface. UVs are
# per corner in Blender, so welding keeps them and the exporter splits the seams again.
import bmesh
bm = bmesh.new()
bm.from_mesh(body.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bm.to_mesh(body.data)
bm.free()
if body.data.has_custom_normals:
    select_only([body])
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
height = max(v.co.z for v in body.data.vertices) - min(v.co.z for v in body.data.vertices)

# 2. Armature: one bone per joint, head at the joint, tail at its main child.
nodes = cfg['skeleton']
by_id = {n['id']: n for n in nodes}
children = {n['id']: [] for n in nodes}
for n in nodes:
    if n['parent'] is not None:
        children[n['parent']].append(n['id'])


def descendants(i):
    return 1 + sum(descendants(c) for c in children[i])


armature_data = bpy.data.armatures.new('Armature')
rig = bpy.data.objects.new('Armature', armature_data)
scene.collection.objects.link(rig)
select_only([rig])
bpy.ops.object.mode_set(mode='EDIT')
edit = armature_data.edit_bones
for n in nodes:
    bone = edit.new(n['id'])
    head = blender(n['position'])
    kids = children[n['id']]
    if kids:
        main = max(kids, key=lambda c: (descendants(c), c in ('spine', 'chest', 'neck', 'head')))
        tail = blender(by_id[main]['position'])
    elif n['parent'] is not None:
        direction = head - blender(by_id[n['parent']]['position'])
        tail = head + direction.normalized() * max(n['radius'], 0.02 * height)
    else:
        tail = head + Vector((0, 0, max(n['radius'], 0.1 * height)))
    if (tail - head).length < 1e-4:
        tail = head + Vector((0, 0, max(n['radius'], 0.01)))
    bone.head, bone.tail = head, tail
    # Local Z faces forward on upright bones and up on level ones, so rotation about local X
    # is always a swing in the body's side plane (legs forward, tails and necks up).
    axis = (tail - head).normalized()
    bone.align_roll(Vector((0, -1, 0)) if abs(axis.z) > 0.7 else Vector((0, 0, 1)))
for n in nodes:
    if n['parent'] is not None:
        edit[n['id']].parent = edit[n['parent']]
bpy.ops.object.mode_set(mode='OBJECT')

# 3. Skin with automatic (heat) weights; vertices the solver misses go to the nearest bone.
select_only([body, rig], rig)
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
# Skinned meshes belong at the glTF root; the Armature modifier alone keeps the binding.
world = body.matrix_world.copy()
body.parent = None
body.matrix_world = world
segments = []
for b in rig.data.bones:
    segments.append((b.name, rig.matrix_world @ b.head_local, rig.matrix_world @ b.tail_local))
for b in segments:
    if b[0] not in [g.name for g in body.vertex_groups]:
        body.vertex_groups.new(name=b[0])
def nearest_bones(p, allowed=None):
    """(distance, bone) pairs to every allowed bone segment, nearest first."""
    out_ = []
    for name, a, b in segments:
        if allowed is not None and name not in allowed:
            continue
        ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
        out_.append(((a + ab * t - p).length, name))
    return sorted(out_)


def blend(index, near):
    """Inverse-distance blend of the two nearest bones, replacing any heat weights."""
    for g in body.vertex_groups:
        g.remove([index])
    (d0, n0) = near[0]
    w0 = 1.0 / max(d0, 1e-5) ** 4
    w1, n1 = 0.0, None
    if len(near) > 1:
        d1, n1 = near[1]
        w1 = 1.0 / max(d1, 1e-5) ** 4
    body.vertex_groups[n0].add([index], w0 / (w0 + w1), 'REPLACE')
    if n1:
        body.vertex_groups[n1].add([index], w1 / (w0 + w1), 'REPLACE')


# Connected parts: large ones keep heat weights; small attachments (helmets, shields, ears)
# follow only the bone nearest their centre and its parent, so a raised arm cannot drag a
# tabard or a shield on the back.
count = len(body.data.vertices)
parent_of = list(range(count))


def find(i):
    while parent_of[i] != i:
        parent_of[i] = parent_of[parent_of[i]]
        i = parent_of[i]
    return i


for e in body.data.edges:
    a, b = find(e.vertices[0]), find(e.vertices[1])
    if a != b:
        parent_of[a] = b
islands = {}
for i in range(count):
    islands.setdefault(find(i), []).append(i)
coords = [body.matrix_world @ v.co for v in body.data.vertices]
unweighted = attached = 0
bone_parent = {b.name: (b.parent.name if b.parent else None) for b in rig.data.bones}
for members in islands.values():
    if len(members) >= 0.2 * count:
        for i in members:
            if sum(g.weight for g in body.data.vertices[i].groups) <= 1e-4:
                unweighted += 1
                blend(i, nearest_bones(coords[i]))
        continue
    attached += 1
    centre = sum((coords[i] for i in members), Vector()) / len(members)
    home = nearest_bones(centre)[0][1]
    allowed = {home, bone_parent[home]} - {None}
    for i in members:
        blend(i, nearest_bones(coords[i], allowed))


# 4. Procedural clips. Angles in degrees; pitch rotates about local X (tip toward local Z).
ids = set(by_id)
low = lambda i: i in by_id and by_id[i]['position'][1] < 0.3 * height
has = lambda *names: all(n in ids for n in names)
def level_body():
    """True when the torso runs front to back (hips to chest/neck/head mostly horizontal)."""
    top = next((i for i in ('chest', 'neck', 'head', 'spine') if i in ids), None)
    if 'hips' not in ids or not top:
        return False
    a, b = by_id['hips']['position'], by_id[top]['position']
    return abs(b[2] - a[2]) > abs(b[1] - a[1])


# Front legs reaching the ground alone is not enough: chibi arms hang low too.
if has('thigh_l', 'thigh_r', 'upperarm_l', 'upperarm_r') and (low('hand_l') or low('forearm_l')) and level_body():
    kind = 'quadruped'
elif has('thigh_l', 'thigh_r'):
    kind = 'biped'
else:
    kind = 'generic'
tails = sorted([i for i in ids if i.startswith('tail')], key=lambda i: (len(i), i))
root = next(n['id'] for n in nodes if n['parent'] is None)


def chain(start):
    """A joint and its main descendants: thigh_l -> shin_l -> foot_l."""
    out_ = [start]
    while children[out_[-1]]:
        out_.append(max(children[out_[-1]], key=descendants))
    return out_


def wave(t, phase=0.0):
    return math.sin(2 * math.pi * t + phase)


def legs(t, pairs, amp, bend, phases):
    """Swing each leg chain; the second joint folds backward during the forward swing."""
    pose = {}
    for (top, phase) in zip(pairs, phases):
        if top not in ids:
            continue
        parts = chain(top)
        pose[parts[0]] = (amp * wave(t, phase), 0)
        if len(parts) > 1:
            pose[parts[1]] = (-bend * max(0.0, wave(t, phase + math.pi / 2)), 0)
    return pose


def tail_pose(t, yaw, pitch=0.0, speed=1.0):
    return {name: (pitch * wave(t * speed, k * 0.6), yaw * wave(t * speed, -k * 0.7))
            for k, name in enumerate(tails)}


def clip_pose(name, t):
    """{bone: (pitch, side)} in degrees, plus the root's vertical offset in metres."""
    pose, lift = {}, 0.0
    if kind == 'biped':
        if name == 'idle':
            pose.update({'spine': (1.5 * wave(t), 0), 'chest': (1.5 * wave(t, 0.4), 0),
                         'head': (2.5 * wave(t, 1.2), 3 * wave(t * 0.5)),
                         'upperarm_l': (0, 3 * wave(t)), 'upperarm_r': (0, -3 * wave(t))})
            lift = 0.004 * height * wave(t)
        elif name in ('walk', 'run'):
            amp, bend, arm = (25, 30, 20) if name == 'walk' else (45, 70, 40)
            pose.update(legs(t, ['thigh_l', 'thigh_r'], amp, bend, [0, math.pi]))
            for side, phase in (('l', math.pi), ('r', 0)):
                pose['upperarm_' + side] = (arm * wave(t, phase), 0)
                pose['forearm_' + side] = (-8 if name == 'walk' else -55, 0)
            pose['spine'] = (3 if name == 'walk' else 10, 0)
            lift = (0.015 if name == 'walk' else 0.04) * height * abs(math.cos(2 * math.pi * t))
        elif name == 'attack':
            keys = [(0, 0, 0, 0), (0.35, 150, -40, -8), (0.55, 20, -10, 14), (1, 0, 0, 0)]
            arm, fore, spine = interpolate(keys, t)
            pose.update({'upperarm_r': (arm, 0), 'forearm_r': (fore, 0), 'spine': (spine, 0),
                         'chest': (spine * 0.5, 0)})
    elif kind == 'quadruped':
        hind, front = ['thigh_l', 'thigh_r'], ['upperarm_l', 'upperarm_r']
        if name == 'idle':
            pose.update({'chest': (1.5 * wave(t), 0), 'head': (2 * wave(t, 1.0), 10 * wave(t * 0.5)),
                         'neck': (1.5 * wave(t, 0.5), 0)})
            pose.update(tail_pose(t, 12, 0, 2))
            lift = 0.004 * height * wave(t)
        elif name == 'walk':
            pose.update(legs(t, hind + front, 22, 25, [0, math.pi, math.pi, 0]))
            pose.update(tail_pose(t, 8))
            pose['head'] = (3 * wave(t * 2), 0)
            lift = 0.01 * height * abs(math.cos(2 * math.pi * t))
        elif name == 'run':
            pose.update(legs(t, hind + front, 40, 45, [math.pi, math.pi, 0, 0]))
            pose['spine'] = (6 * wave(t), 0)
            pose.update(tail_pose(t, 4, 10))
            lift = 0.05 * height * max(0.0, wave(t, math.pi / 2))
        elif name == 'attack':
            keys = [(0, 0, 0, 0), (0.3, -18, -10, 10), (0.55, 30, 15, -20), (1, 0, 0, 0)]
            neck, head, front_ = interpolate(keys, t)
            pose.update({'neck': (neck, 0), 'head': (head, 0), 'upperarm_l': (front_, 0),
                         'upperarm_r': (front_, 0), 'chest': (neck * 0.3, 0)})
            pose.update(tail_pose(t, 6))
    else:
        # Unknown names: every joint sways a little, delayed down the hierarchy.
        depth = {}
        for n in nodes:
            depth[n['id']] = 0 if n['parent'] is None else depth[n['parent']] + 1
        pose = {i: (3 * wave(t, -0.5 * d), 2 * wave(t * 0.5, -0.4 * d)) for i, d in depth.items() if d}
        lift = 0.004 * height * wave(t)
    return pose, lift


def interpolate(keys, t):
    for (t0, *a), (t1, *b) in zip(keys, keys[1:]):
        if t0 <= t <= t1:
            s = (t - t0) / max(t1 - t0, 1e-6)
            s = s * s * (3 - 2 * s)
            return [x + (y - x) * s for x, y in zip(a, b)]
    return list(keys[-1][1:])


CLIPS = {'idle': (2.5, True), 'walk': (1.0, True), 'run': (0.6, True), 'attack': (0.9, False)}
supported = ['idle'] if kind == 'generic' else list(CLIPS)
wanted = [c for c in cfg.get('clips', supported) if c in supported] or ['idle']
rig.animation_data_create()
for b in rig.pose.bones:
    b.rotation_mode = 'XYZ'
root_bone = rig.pose.bones[root]
# Root offsets are keyed in the root bone's rest frame; convert world up into it.
up_local = rig.data.bones[root].matrix_local.to_3x3().inverted() @ Vector((0, 0, 1))
made = []
for name in wanted:
    seconds, loop = CLIPS[name]
    frames = round(seconds * FPS)
    action = bpy.data.actions.new(name)
    rig.animation_data.action = action
    # Keys from frame 0 (the exporter writes scene time) through the closing loop frame.
    step = 2 if frames > 20 else 1
    for frame in sorted(set(range(0, frames, step)) | {frames}):
        t = (frame / frames) % 1.0 if loop else frame / frames
        pose, lift = clip_pose(name, t)
        for b in rig.pose.bones:
            pitch, side = pose.get(b.name, (0, 0))
            b.rotation_euler = (math.radians(pitch), 0, math.radians(side))
            b.keyframe_insert('rotation_euler', frame=frame)
        root_bone.location = up_local * lift
        root_bone.keyframe_insert('location', frame=frame)
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, action)
    rig.animation_data.action = None
    made.append({'name': name, 'seconds': seconds, 'loop': loop, 'frames': frames})
for b in rig.pose.bones:
    b.rotation_euler = (0, 0, 0)
    b.location = (0, 0, 0)

# 5. Export the rigged asset with one glTF animation per NLA track.
select_only([body, rig], rig)
bpy.ops.export_scene.gltf(
    filepath=os.path.join(out, 'rigged.glb'), export_format='GLB', use_selection=True,
    export_yup=True, export_apply=False, export_tangents=True, export_animations=True,
    export_animation_mode='NLA_TRACKS', export_skins=True, export_def_bones=False,
    export_cameras=False, export_lights=False, export_extras=False)

# 6. Preview frames: Workbench with the baked colours, a fixed 3/4 orthographic camera.
preview = cfg.get('preview', {'size': 256, 'frames': 12})
size, count = int(preview['size']), int(preview['frames'])
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'TEXTURE'
scene.display.shading.show_shadows = False
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = size
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
corners = [body.matrix_world @ Vector(c) for c in body.bound_box]
lo, hi = Vector(map(min, *corners)), Vector(map(max, *corners))
centre = (lo + hi) / 2
camera_data = bpy.data.cameras.new('Preview')
camera_data.type = 'ORTHO'
camera_data.ortho_scale = max(hi - lo) * 1.2
camera = bpy.data.objects.new('Preview', camera_data)
scene.collection.objects.link(camera)
direction = Vector((0.7, -1.0, 0.45)).normalized()
camera.location = centre + direction * (max(hi - lo) * 4 + 1)
camera.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
scene.camera = camera
for clip in made:
    track = rig.animation_data.nla_tracks[clip['name']]
    track.is_solo = True
    for index in range(count):
        frame = round(index * clip['frames'] / (count if clip['loop'] else count - 1))
        scene.frame_set(frame)
        scene.render.filepath = os.path.join(out, 'preview-%s-%02d.png' % (clip['name'], index))
        bpy.ops.render.render(write_still=True)
    track.is_solo = False

report = {'kind': kind, 'bones': len(rig.data.bones), 'clips': made, 'unweighted': unweighted,
          'attachments': attached,
          'vertices': len(body.data.vertices), 'seconds': round(time.time() - started, 2)}
print('AHA_RIG=' + json.dumps(report))
`;

export const GEN3D_STYLIZE_SCRIPT = String.raw`# Aha 3D generation fixed stylization script (headless Blender). Never runs AI source.
# Usage: blender -b --factory-startup --disable-autoexec --python stylize.py -- config.json
# style "voxel": solid voxels at the detail value cells along the longest side, merged faces, colours
#   from the source surface. "bricks": the same with brick proportions, studs on exposed tops
#   and a fixed colour palette. "lowpoly": decimated to the detail value triangles with flat faces.
import bpy, bmesh, json, math, os, sys, time
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.interpolate import poly_3d_calc

started = time.time()
with open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8') as handle:
    cfg = json.load(handle)
out, style, detail = cfg['output'], cfg['style'], int(cfg['detail'])
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def select_only(objects, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objects[-1]


bpy.ops.import_scene.gltf(filepath=cfg['input'])
meshes = [o for o in scene.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError('The model contains no meshes.')
select_only(meshes)
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in [o for o in scene.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o)
select_only(meshes, meshes[0])
if len(meshes) > 1:
    bpy.ops.object.join()
source = bpy.context.active_object
mesh = source.data
source_triangles = sum(len(p.vertices) - 2 for p in mesh.polygons)
tree = BVHTree.FromObject(source, bpy.context.evaluated_depsgraph_get())


# --- colour of the source surface at a point -------------------------------------------------
def srgb(c):
    return [x * 12.92 if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055 for x in c]


samplers = []
for material in mesh.materials:
    entry = {'color': [0.8, 0.8, 0.8], 'image': None}
    bsdf = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if material and material.use_nodes else None
    if bsdf:
        socket = bsdf.inputs['Base Color']
        entry['color'] = srgb(list(socket.default_value)[:3])
        node = socket.links[0].from_node if socket.links else None
        # glTF imports factor * texture through a Mix node; look one step behind it as well.
        if node and node.type != 'TEX_IMAGE':
            node = next((l.from_node for i in node.inputs for l in i.links if l.from_node.type == 'TEX_IMAGE'), node)
        if node and node.type == 'TEX_IMAGE' and node.image and node.image.size[0]:
            w, h = node.image.size
            pixels = np.empty(w * h * 4, np.float32)
            node.image.pixels.foreach_get(pixels)
            entry['image'] = pixels.reshape(h, w, 4)
    samplers.append(entry)
uv_layer = mesh.uv_layers.active.data if mesh.uv_layers.active else None


def surface_color(point):
    """sRGB colour of the nearest source surface point."""
    location, _normal, index, _distance = tree.find_nearest(point)
    if index is None:
        return (0.8, 0.8, 0.8)
    polygon = mesh.polygons[index]
    entry = samplers[polygon.material_index] if polygon.material_index < len(samplers) else {'color': [0.8] * 3, 'image': None}
    image = entry['image']
    if image is None or uv_layer is None:
        return tuple(entry['color'])
    corners = [mesh.vertices[v].co for v in polygon.vertices]
    weights = poly_3d_calc(corners, location)
    u = sum(w * uv_layer[l].uv[0] for w, l in zip(weights, polygon.loop_indices))
    v = sum(w * uv_layer[l].uv[1] for w, l in zip(weights, polygon.loop_indices))
    h, w = image.shape[:2]
    x = min(w - 1, max(0, int((u % 1.0) * w)))
    y = min(h - 1, max(0, int((v % 1.0) * h)))
    return tuple(float(c) for c in image[y, x, :3])


# Bricks use a fixed palette so neighbouring bricks share colours like a real kit.
PALETTE = [
    (0.96, 0.96, 0.96), (0.63, 0.65, 0.66), (0.35, 0.36, 0.37), (0.11, 0.11, 0.12),
    (0.79, 0.10, 0.10), (0.55, 0.06, 0.08), (0.98, 0.78, 0.12), (0.93, 0.55, 0.13),
    (0.85, 0.44, 0.18), (0.98, 0.90, 0.70), (0.85, 0.72, 0.50), (0.55, 0.38, 0.22),
    (0.36, 0.22, 0.14), (0.20, 0.55, 0.20), (0.10, 0.35, 0.18), (0.65, 0.80, 0.30),
    (0.10, 0.40, 0.75), (0.05, 0.20, 0.45), (0.45, 0.70, 0.90), (0.55, 0.30, 0.65),
    (0.90, 0.55, 0.70), (0.30, 0.65, 0.65),
]


def quantize(color):
    if style == 'bricks':
        return min(PALETTE, key=lambda p: sum((a - b) ** 2 for a, b in zip(p, color)))
    # Voxels keep the source colours, rounded so equal neighbours merge into larger faces.
    return tuple(round(c * 15) / 15 for c in color)


CELL = 8  # palette cell size in pixels; faces sample the cell centre, so filtering stays inside


def build(name, verts, faces, colors):
    """A mesh whose faces sample a generated palette texture: one cell per colour, every face's
    UVs at its cell centre. Engines that ignore vertex colours (Godot's glTF import) still show
    the colours, and OBJ keeps them through its texture."""
    palette = sorted(set(colors))
    if len(palette) > 4096:
        raise RuntimeError('Too many colours for the palette.')
    slot = {c: i for i, c in enumerate(palette)}
    per_row = max(1, math.ceil(math.sqrt(len(palette))))
    size = per_row * CELL
    pixels = np.ones((size, size, 4), np.float32)
    for c, i in slot.items():
        row, col = divmod(i, per_row)
        pixels[row * CELL:(row + 1) * CELL, col * CELL:(col + 1) * CELL, :3] = c
    image = bpy.data.images.new('palette', size, size, alpha=False)
    image.colorspace_settings.name = 'sRGB'
    image.pixels.foreach_set(pixels.ravel())
    image.pack()
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    uv = data.uv_layers.new(name='UVMap')
    for polygon, color in zip(data.polygons, colors):
        row, col = divmod(slot[color], per_row)
        centre = ((col + 0.5) / per_row, (row + 0.5) / per_row)
        for loop in polygon.loop_indices:
            uv.data[loop].uv = centre
    for polygon in data.polygons:
        polygon.use_smooth = False
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj['aha_palette'] = image.name
    return obj


def finish(obj, roughness):
    material = bpy.data.materials.new('Stylized')
    material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = bpy.data.images[obj['aha_palette']]
    texture.interpolation = 'Closest'
    material.node_tree.links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0.0
    obj.data.materials.clear()
    obj.data.materials.append(material)
    del obj['aha_palette']


stats = {}
if style in ('voxel', 'bricks'):
    corners = [source.matrix_world @ Vector(c) for c in source.bound_box]
    lo, hi = np.array(Vector(map(min, *corners))), np.array(Vector(map(max, *corners)))
    size = hi - lo
    cell = float(size.max()) / detail
    # Brick proportions: plates are as wide as they are deep, bricks 1.2 times taller.
    step = np.array([cell, cell, cell * (1.2 if style == 'bricks' else 1.0)])
    dims = np.maximum(1, np.ceil(size / step).astype(int)) + 2  # one empty cell around
    # Grid centred on the model with one empty cell of padding on every side.
    origin = lo - step - ((dims - 2) * step - size) / 2
    # Shell: cells whose centre is within reach of the surface.
    reach = float(np.linalg.norm(step)) * 0.5
    shell = np.zeros(dims, bool)
    for i in range(dims[0]):
        for j in range(dims[1]):
            for k in range(dims[2]):
                centre = Vector(origin + (np.array([i, j, k]) + 0.5) * step)
                if tree.find_nearest(centre, reach)[0] is not None:
                    shell[i, j, k] = True
    # Outside = empty cells reachable from the border; everything else is solid, so models made
    # of intersecting parts or with tiny gaps still come out filled.
    outside = np.zeros(dims, bool)
    outside[0, :, :] = outside[-1, :, :] = outside[:, 0, :] = outside[:, -1, :] = True
    outside[:, :, 0] = outside[:, :, -1] = True
    outside &= ~shell
    while True:
        grown = outside.copy()
        for axis in range(3):
            for shift in (1, -1):
                grown |= np.roll(outside, shift, axis) & ~shell
        if (grown == outside).all():
            break
        outside = grown
    solid = ~outside
    exposed = np.zeros(dims, bool)
    for axis in range(3):
        for shift in (1, -1):
            exposed |= solid & np.roll(outside, shift, axis)
    color = {}
    for idx in zip(*np.nonzero(exposed)):
        centre = Vector(origin + (np.array(idx) + 0.5) * step)
        color[idx] = quantize(surface_color(centre))
    # Hidden solid cells take the colour of an exposed neighbour (only matters for studs).
    verts, faces, colors = [], [], []
    # Greedy meshing: per axis direction and slice, merge equal-coloured exposed faces into
    # rectangles.
    for axis in range(3):
        u_axis, v_axis = [a for a in range(3) if a != axis]
        for direction in (1, -1):
            neighbour_outside = np.roll(outside, -direction, axis)
            face_mask = solid & neighbour_outside
            for layer in range(dims[axis]):
                index = [slice(None)] * 3
                index[axis] = layer
                mask = face_mask[tuple(index)]
                if not mask.any():
                    continue
                labels = {}
                nu, nv = mask.shape
                done = np.zeros_like(mask)
                for a in range(nu):
                    for b in range(nv):
                        if not mask[a, b] or done[a, b]:
                            continue
                        cell_index = [0, 0, 0]
                        cell_index[axis], cell_index[u_axis], cell_index[v_axis] = layer, a, b
                        c = color.get(tuple(cell_index), (0.8, 0.8, 0.8))

                        def same(x, y):
                            ci = [0, 0, 0]
                            ci[axis], ci[u_axis], ci[v_axis] = layer, x, y
                            return mask[x, y] and not done[x, y] and color.get(tuple(ci), (0.8, 0.8, 0.8)) == c
                        width = 1
                        while b + width < nv and same(a, b + width):
                            width += 1
                        height = 1
                        while a + height < nu and all(same(a + height, b + t) for t in range(width)):
                            height += 1
                        done[a:a + height, b:b + width] = True
                        plane = origin[axis] + (layer + (1 if direction > 0 else 0)) * step[axis]
                        quad = []
                        for du, dv in ((0, 0), (height, 0), (height, width), (0, width)):
                            p = [0.0, 0.0, 0.0]
                            p[axis] = plane
                            p[u_axis] = origin[u_axis] + (a + du) * step[u_axis]
                            p[v_axis] = origin[v_axis] + (b + dv) * step[v_axis]
                            quad.append(p)
                        # Wind counter-clockwise when seen from outside.
                        normal = np.cross(np.subtract(quad[1], quad[0]), np.subtract(quad[3], quad[0]))
                        if normal[axis] * direction < 0:
                            quad.reverse()
                        start = len(verts)
                        verts.extend(quad)
                        faces.append((start, start + 1, start + 2, start + 3))
                        colors.append(c)
    stats['voxels'] = int(solid.sum())
    if style == 'bricks':
        # Studs: a short cylinder on every exposed top (+Z in Blender).
        top = solid & np.roll(outside, -1, 2)
        sides = 10
        radius, rise = cell * 0.3, step[2] * 0.17
        studs = 0
        for i, j, k in zip(*np.nonzero(top)):
            cx = origin[0] + (i + 0.5) * step[0]
            cy = origin[1] + (j + 0.5) * step[1]
            z0 = origin[2] + (k + 1) * step[2]
            c = color.get((i, j, k), (0.8, 0.8, 0.8))
            start = len(verts)
            for s in range(sides):
                angle = 2 * math.pi * s / sides
                x, y = cx + radius * math.cos(angle), cy + radius * math.sin(angle)
                verts.extend([(x, y, z0), (x, y, z0 + rise)])
            for s in range(sides):
                a0, a1 = start + 2 * s, start + 2 * ((s + 1) % sides)
                faces.append((a0, a1, a1 + 1, a0 + 1))
                colors.append(c)
            faces.append(tuple(start + 2 * s + 1 for s in range(sides)))
            colors.append(c)
            studs += 1
        stats['studs'] = studs
    result = build('Model', verts, faces, colors)
    stats['colors'] = len(set(colors))
    roughness = 0.35 if style == 'bricks' else 0.75
else:
    # Low poly: weld, collapse to the target, then one colour per flat face.
    result = source.copy()
    result.data = source.data.copy()
    scene.collection.objects.link(result)
    bm = bmesh.new()
    bm.from_mesh(result.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=max(1e-5, 1e-4 * max(result.dimensions)))
    bm.to_mesh(result.data)
    bm.free()
    select_only([result])
    modifier = result.modifiers.new('Decimate', 'DECIMATE')
    modifier.ratio = min(1.0, detail / max(1, sum(len(p.vertices) - 2 for p in result.data.polygons)))
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bm = bmesh.new()
    bm.from_mesh(result.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() <= 1e-12], context='FACES')
    verts = [tuple(result.matrix_world @ v.co) for v in bm.verts]
    bm.verts.index_update()
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    # Average a few samples per face so one thin dark stripe cannot paint a whole facet.
    colors = []
    for f in bm.faces:
        centre = f.calc_center_median()
        points = [centre] + [centre.lerp(v.co, 0.6) for v in f.verts]
        samples = [surface_color(result.matrix_world @ p) for p in points]
        # 5 bits per channel keeps the palette within 4096 cells for any triangle count.
        colors.append(tuple(round(sum(c[i] for c in samples) / len(samples) * 31) / 31 for i in range(3)))
    bm.free()
    bpy.data.objects.remove(result)
    result = build('Model', verts, faces, colors)
    stats['colors'] = len(set(colors))
    roughness = 0.8
bpy.data.objects.remove(source)
finish(result, roughness)
# Bottom centre, like every published version.
corners = [result.matrix_world @ Vector(c) for c in result.bound_box]
lo, hi = Vector(map(min, *corners)), Vector(map(max, *corners))
result.data.transform(Matrix.Translation(-Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))))
select_only([result])
bpy.ops.export_scene.gltf(
    filepath=os.path.join(out, 'model.glb'), export_format='GLB', use_selection=True, export_yup=True,
    export_apply=True, export_animations=False, export_cameras=False, export_lights=False, export_extras=False)
report = {'style': style, 'detail': detail, 'triangles': sum(len(p.vertices) - 2 for p in result.data.polygons),
          'sourceTriangles': source_triangles, **stats, 'seconds': round(time.time() - started, 2)}
print('AHA_STYLIZE=' + json.dumps(report))
`;

export const GEN3D_PROP_SCRIPT = String.raw`# Aha 3D generation fixed prop animation script (headless Blender). Never runs AI source.
# Usage: blender -b --factory-startup --disable-autoexec --python prop.py -- config.json
# Moves the chosen parts around a pivot on their combined bounds: a lid or a door on a hinge,
# a spin, or a slide; exports animated.glb (one glTF animation per clip) and preview frames.
import bpy, json, math, os, sys, time
from mathutils import Matrix, Vector

started = time.time()
with open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8') as handle:
    cfg = json.load(handle)
out, motion = cfg['output'], cfg['motion']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
FPS = 30
scene.render.fps = FPS
bpy.ops.import_scene.gltf(filepath=cfg['input'])
for o in [o for o in scene.objects if o.type in ('CAMERA', 'LIGHT')]:
    bpy.data.objects.remove(o)


def base(name):
    """glTF node names come back unique per Blender datablock; Blender may add .001."""
    return name.rsplit('.', 1)[0] if len(name) > 4 and name[-4] == '.' and name[-3:].isdigit() else name


wanted = set(cfg['parts'])
chosen = [o for o in scene.objects if base(o.name) in wanted or o.get('ahaId') in wanted]
if not chosen:
    raise RuntimeError('None of the chosen parts are in the model.')
def parents(o):
    while o.parent:
        o = o.parent
        yield o


# Only move the top-most chosen objects; their children follow.
movers = [o for o in chosen if not any(p in chosen for p in parents(o))]
points = []
for o in movers:
    for child in [o, *o.children_recursive]:
        if child.type == 'MESH':
            points += [child.matrix_world @ Vector(c) for c in child.bound_box]
if not points:
    raise RuntimeError('The chosen parts have no geometry.')
lo, hi = Vector(map(min, *points)), Vector(map(max, *points))
centre = (lo + hi) / 2
size = hi - lo

# Work in glTF terms (Y up, +Z front) and convert: glTF (x, y, z) = Blender (x, -z, y).
gx = (lo.x, hi.x)          # glTF x range (Blender x)
gy = (lo.z, hi.z)          # glTF y range (Blender z)
gz = (-hi.y, -lo.y)        # glTF z range (Blender -y)
angle = math.radians(float(cfg.get('angle', 100)))
edge = cfg.get('edge', 'back')
mid = lambda r: (r[0] + r[1]) / 2
if motion == 'lid':
    # Hinge along the chosen bottom edge; the far side lifts.
    pivot_g = {'back': (mid(gx), gy[0], gz[0]), 'front': (mid(gx), gy[0], gz[1]),
               'left': (gx[1], gy[0], mid(gz)), 'right': (gx[0], gy[0], mid(gz))}[edge]
    axis_g, sign = {'back': ('x', -1), 'front': ('x', 1), 'left': ('z', -1), 'right': ('z', 1)}[edge]
elif motion == 'door':
    # Vertical hinge on the left (+x) or right (-x) edge; the door swings out to the front.
    pivot_g = {'left': (gx[1], mid(gy), mid(gz)), 'right': (gx[0], mid(gy), mid(gz))}[edge]
    axis_g, sign = ('y', 1 if edge == 'left' else -1)
elif motion == 'spin':
    pivot_g, axis_g, sign = (mid(gx), mid(gy), mid(gz)), 'y', 1
else:
    pivot_g = (mid(gx), mid(gy), mid(gz))
    axis_g, sign = None, 1


def blender_point(p):
    return Vector((p[0], -p[2], p[1]))


# Rotation about glTF x / y / z = Blender x / z / -y.
blender_axis = {'x': (0, 1.0), 'y': (2, 1.0), 'z': (1, -1.0)}
pivot = bpy.data.objects.new(cfg.get('pivotName', 'Pivot'), None)
scene.collection.objects.link(pivot)
pivot.location = blender_point(pivot_g)
pivot.rotation_mode = 'XYZ'
bpy.context.view_layer.update()
for o in movers:
    world = o.matrix_world.copy()
    o.parent = pivot
    o.matrix_parent_inverse = pivot.matrix_world.inverted()
    o.matrix_world = world

seconds = float(cfg.get('seconds', 1.0))
direction = {'forward': (0, 0, 1), 'up': (0, 1, 0), 'left': (1, 0, 0), 'right': (-1, 0, 0)}[cfg.get('direction', 'forward')]
extent_g = {'forward': size.y, 'up': size.z, 'left': size.x, 'right': size.x}[cfg.get('direction', 'forward')]
distance = float(cfg.get('distance') or 0.8 * extent_g)


def ease(t):
    return t * t * (3 - 2 * t)


def pose(amount):
    """amount 0 = rest, 1 = open (for spin: turns, may exceed 1)."""
    pivot.rotation_euler = (0, 0, 0)
    pivot.location = blender_point(pivot_g)
    if motion == 'slide':
        offset = Vector(direction) * distance * amount
        pivot.location = blender_point([pivot_g[i] + offset[i] for i in range(3)])
    else:
        index, flip = blender_axis[axis_g]
        rotation = [0.0, 0.0, 0.0]
        turn = 2 * math.pi * amount if motion == 'spin' else angle * amount
        rotation[index] = sign * flip * turn
        pivot.rotation_euler = rotation


clips = [('spin', seconds, True, lambda t: t)] if motion == 'spin' else [
    ('open', seconds, False, ease), ('close', seconds, False, lambda t: 1 - ease(t))]
pivot.animation_data_create()
made = []
for name, length, loop, curve in clips:
    frames = max(2, round(length * FPS))
    action = bpy.data.actions.new(name)
    pivot.animation_data.action = action
    step = 2 if frames > 20 else 1
    for frame in sorted(set(range(0, frames, step)) | {frames}):
        pose(curve(frame / frames))
        pivot.keyframe_insert('rotation_euler', frame=frame)
        pivot.keyframe_insert('location', frame=frame)
    if motion == 'spin':
        # Linear turns so the loop has no ease at the seam.
        for fcurve in action.fcurves if hasattr(action, 'fcurves') else []:
            for key in fcurve.keyframe_points:
                key.interpolation = 'LINEAR'
    track = pivot.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, action)
    pivot.animation_data.action = None
    made.append({'name': name, 'seconds': length, 'loop': loop, 'frames': frames})
pose(0)

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(
    filepath=os.path.join(out, 'animated.glb'), export_format='GLB', use_selection=True, export_yup=True,
    export_apply=False, export_tangents=True, export_animations=True, export_animation_mode='NLA_TRACKS',
    export_cameras=False, export_lights=False, export_extras=True)

preview = cfg.get('preview', {'size': 256, 'frames': 12})
size_px, count = int(preview['size']), int(preview['frames'])
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'TEXTURE'
scene.display.shading.show_shadows = False
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = size_px
scene.render.image_settings.file_format = 'PNG'
meshes = [o for o in scene.objects if o.type == 'MESH']
everything = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
# Frame the opened pose too, so a lifted lid stays in the picture.
pose(1 if motion != 'spin' else 0)
bpy.context.view_layer.update()
everything += [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
pose(0)
low, high = Vector(map(min, *everything)), Vector(map(max, *everything))
camera_data = bpy.data.cameras.new('Preview')
camera_data.type = 'ORTHO'
camera_data.ortho_scale = max(high - low) * 1.25
camera = bpy.data.objects.new('Preview', camera_data)
scene.collection.objects.link(camera)
view = Vector((0.7, -1.0, 0.6)).normalized()
camera.location = (low + high) / 2 + view * (max(high - low) * 4 + 1)
camera.rotation_euler = (-view).to_track_quat('-Z', 'Y').to_euler()
scene.camera = camera
for clip in made:
    track = pivot.animation_data.nla_tracks[clip['name']]
    track.is_solo = True
    for index in range(count):
        frame = round(index * clip['frames'] / (count if clip['loop'] else count - 1))
        scene.frame_set(frame)
        scene.render.filepath = os.path.join(out, 'preview-%s-%02d.png' % (clip['name'], index))
        bpy.ops.render.render(write_still=True)
    track.is_solo = False

report = {'motion': motion, 'parts': len(movers), 'clips': [{k: c[k] for k in ('name', 'seconds', 'loop')} for c in made],
          'pivot': [round(v, 4) for v in pivot_g], 'seconds': round(time.time() - started, 2)}
print('AHA_PROP=' + json.dumps(report))
`;
