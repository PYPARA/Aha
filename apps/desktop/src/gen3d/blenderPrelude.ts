// Helpers prepended to AI-written Blender Python for 3D generation. The workshop's source
// policy checks the combined text, so this code must avoid file, path and dynamic-attribute
// names just like generated code.
export const GEN3D_BLENDER_PRELUDE = `import bpy, math
from mathutils import Vector

aha_skeleton = json.loads(params['skeleton']) if 'skeleton' in params else None

def aha_point(p):
    # Aha data is Y-up metres like the published glTF; Blender is Z-up.
    return Vector((p[0], -p[2], p[1]))

# Subdivision rounds the square skin section to about 0.93 of the skin radius (measured
# in Blender 5.2 for levels 1-3); scale radii so the body keeps each node's radius.
AHA_SKIN_SHRINK = {0: 1.0, 1: 1.075, 2: 1.075, 3: 1.075}

def aha_skin(skeleton=None, name='Body', subdivisions=2, material=None):
    nodes = skeleton if skeleton is not None else aha_skeleton
    if not nodes:
        raise ValueError('aha_skin needs a skeleton: pass "skeleton" in the gen3d submit call.')
    order = {n['id']: i for i, n in enumerate(nodes)}
    verts = [aha_point(n['position']) for n in nodes]
    edges = [(order[n['parent']], i) for i, n in enumerate(nodes) if n['parent'] is not None]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, edges, [])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    skin = obj.modifiers.new('Skin', 'SKIN')
    skin.use_smooth_shade = True
    level = max(0, min(3, int(subdivisions)))
    scale = AHA_SKIN_SHRINK[level]
    layer = mesh.skin_vertices[0].data
    for i, n in enumerate(nodes):
        r = n['radius'] * scale
        layer[i].radius = (r, r)
        layer[i].use_root = n['parent'] is None
    if level:
        sub = obj.modifiers.new('Subdivision', 'SUBSURF')
        sub.levels = level
        sub.render_levels = level
    if material is not None:
        obj.data.materials.append(material)
    return obj

def aha_material(name, color, roughness=0.6, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    value = color.lstrip('#')
    rgb = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    rgb = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    return m

`;

const PRELUDE_LINES = GEN3D_BLENDER_PRELUDE.split("\n").length - 1;
// BlenderRuntime.build puts `import json` and `params = ...` before the checked source.
const PARAMS_LINES = 2;
/** Rewrites line numbers in Blender errors so they point into the AI's own source. */
export function mapBlenderError(message: string) {
  if (message.includes("Aha modeling source cannot"))
    return message.replace(/\(line (\d+)\)/g, (match, line: string) => {
      const own = Number(line) - PRELUDE_LINES;
      return own > 0 ? `(line ${own} of your source)` : match;
    });
  // The MCP addon reports tracebacks inside JSON, so the quotes may be escaped.
  return message.replace(/File \\?"<string>\\?", line (\d+)/g, (match, line: string) => {
    const own = Number(line) - PARAMS_LINES - PRELUDE_LINES;
    return own > 0 ? `line ${own} of your source` : match;
  });
}
