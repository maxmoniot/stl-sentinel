/**
 * STL Sentinel — Mesh Parser
 * Handles STL (binary + ASCII) and OBJ files.
 * Returns a unified { triangles, vertices, triangleCount, format } object.
 */

const STLParser = (() => {

    /**
     * Auto-detect format and parse
     * @param {ArrayBuffer} buffer
     * @param {string} fileName
     */
    function parse(buffer, fileName) {
        const ext = (fileName || '').split('.').pop().toLowerCase();
        if (ext === 'obj') {
            return parseOBJ(buffer);
        }
        // Default: STL
        if (isAsciiSTL(buffer)) {
            return parseAsciiSTL(buffer);
        }
        return parseBinarySTL(buffer, new DataView(buffer));
    }

    // ==========================================================
    // STL
    // ==========================================================

    function isAsciiSTL(buffer) {
        const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1000));
        const header = String.fromCharCode.apply(null, bytes);
        if (!header.trimStart().startsWith('solid')) return false;
        if (header.includes('facet')) return true;
        return false;
    }

    function parseBinarySTL(buffer, dataView) {
        const triangleCount = dataView.getUint32(80, true);
        const expectedSize = 84 + triangleCount * 50;
        if (buffer.byteLength < expectedSize) {
            throw new Error(`Fichier STL binaire corrompu : taille attendue ${expectedSize}, taille réelle ${buffer.byteLength}`);
        }

        const triangles = [];
        const vertices = [];
        let offset = 84;

        for (let i = 0; i < triangleCount; i++) {
            const nx = dataView.getFloat32(offset, true);
            const ny = dataView.getFloat32(offset + 4, true);
            const nz = dataView.getFloat32(offset + 8, true);
            offset += 12;

            const tri = [];
            for (let v = 0; v < 3; v++) {
                const x = dataView.getFloat32(offset, true);
                const y = dataView.getFloat32(offset + 4, true);
                const z = dataView.getFloat32(offset + 8, true);
                offset += 12;
                tri.push({ x, y, z });
                vertices.push({ x, y, z });
            }

            triangles.push({ normal: { x: nx, y: ny, z: nz }, vertices: tri });
            offset += 2;
        }

        return { triangles, vertices, triangleCount, format: 'STL binaire' };
    }

    function parseAsciiSTL(buffer) {
        const text = new TextDecoder().decode(buffer);
        const triangles = [];
        const vertices = [];

        const facetRegex = /facet\s+normal\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+outer\s+loop\s+vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+vertex\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+endloop\s+endfacet/gi;

        let match;
        while ((match = facetRegex.exec(text)) !== null) {
            const normal = { x: parseFloat(match[1]), y: parseFloat(match[2]), z: parseFloat(match[3]) };
            const v1 = { x: parseFloat(match[4]), y: parseFloat(match[5]), z: parseFloat(match[6]) };
            const v2 = { x: parseFloat(match[7]), y: parseFloat(match[8]), z: parseFloat(match[9]) };
            const v3 = { x: parseFloat(match[10]), y: parseFloat(match[11]), z: parseFloat(match[12]) };
            triangles.push({ normal, vertices: [v1, v2, v3] });
            vertices.push(v1, v2, v3);
        }

        return { triangles, vertices, triangleCount: triangles.length, format: 'STL ASCII' };
    }

    // ==========================================================
    // OBJ
    // ==========================================================

    function parseOBJ(buffer) {
        const text = new TextDecoder().decode(buffer);
        const lines = text.split('\n');

        const verts = [];   // indexed vertex list
        const triangles = [];
        const vertices = [];

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.startsWith('v ')) {
                const parts = line.split(/\s+/);
                verts.push({
                    x: parseFloat(parts[1]) || 0,
                    y: parseFloat(parts[2]) || 0,
                    z: parseFloat(parts[3]) || 0
                });
            } else if (line.startsWith('f ')) {
                const parts = line.split(/\s+/).slice(1);
                // Parse face indices (supports v, v/vt, v/vt/vn, v//vn)
                const indices = parts.map(p => {
                    const idx = parseInt(p.split('/')[0]);
                    return idx > 0 ? idx - 1 : verts.length + idx; // handle negative indices
                });

                // Triangulate (fan triangulation for polygons)
                for (let i = 1; i < indices.length - 1; i++) {
                    const v1 = verts[indices[0]];
                    const v2 = verts[indices[i]];
                    const v3 = verts[indices[i + 1]];

                    if (!v1 || !v2 || !v3) continue;

                    // Compute face normal
                    const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
                    const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
                    let nx = ay * bz - az * by;
                    let ny = az * bx - ax * bz;
                    let nz = ax * by - ay * bx;
                    const mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
                    if (mag > 0) { nx /= mag; ny /= mag; nz /= mag; }

                    triangles.push({
                        normal: { x: nx, y: ny, z: nz },
                        vertices: [
                            { x: v1.x, y: v1.y, z: v1.z },
                            { x: v2.x, y: v2.y, z: v2.z },
                            { x: v3.x, y: v3.y, z: v3.z }
                        ]
                    });
                    vertices.push(
                        { x: v1.x, y: v1.y, z: v1.z },
                        { x: v2.x, y: v2.y, z: v2.z },
                        { x: v3.x, y: v3.y, z: v3.z }
                    );
                }
            }
        }

        if (triangles.length === 0) {
            throw new Error('Fichier OBJ vide ou invalide : aucune face trouvée');
        }

        return { triangles, vertices, triangleCount: triangles.length, format: 'OBJ' };
    }

    // ==========================================================
    // Geometry utilities
    // ==========================================================

    function computeBoundingBox(vertices) {
        if (vertices.length === 0) return null;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const v of vertices) {
            if (v.x < minX) minX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.z < minZ) minZ = v.z;
            if (v.x > maxX) maxX = v.x;
            if (v.y > maxY) maxY = v.y;
            if (v.z > maxZ) maxZ = v.z;
        }
        return {
            min: { x: minX, y: minY, z: minZ },
            max: { x: maxX, y: maxY, z: maxZ },
            size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ }
        };
    }

    function computeVolume(triangles) {
        let volume = 0;
        for (const tri of triangles) {
            const [v1, v2, v3] = tri.vertices;
            volume += (
                v1.x * (v2.y * v3.z - v3.y * v2.z) -
                v2.x * (v1.y * v3.z - v3.y * v1.z) +
                v3.x * (v1.y * v2.z - v2.y * v1.z)
            ) / 6.0;
        }
        return Math.abs(volume);
    }

    function computeSurfaceArea(triangles) {
        let area = 0;
        for (const tri of triangles) {
            const [v1, v2, v3] = tri.vertices;
            const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
            const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
            const cx = ay * bz - az * by;
            const cy = az * bx - ax * bz;
            const cz = ax * by - ay * bx;
            area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2.0;
        }
        return area;
    }

    return { parse, computeBoundingBox, computeVolume, computeSurfaceArea };
})();
