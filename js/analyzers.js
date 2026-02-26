/**
 * STL Sentinel — Analyzer Modules
 * 
 * Architecture: Each analyzer is a self-contained module with:
 *   - id: unique identifier
 *   - label: display name
 *   - description: what it checks
 *   - defaultPoints: default score weight
 *   - analyze(mesh, settings): returns { pass, score, maxScore, message, severity }
 * 
 * To add a new analyzer: push a new object to STLAnalyzers.registry
 */

const STLAnalyzers = (() => {
    const registry = [];

    /**
     * Register a new analysis module
     */
    function register(analyzer) {
        registry.push(analyzer);
    }

    /**
     * Get all registered analyzers
     */
    function getAll() {
        return [...registry];
    }

    /**
     * Run all analyzers on a parsed mesh
     * @param {Object} mesh - Parsed STL mesh data
     * @param {Object} settings - User settings (dimensions, bareme, etc.)
     * @returns {Object} Full analysis result
     */
    function analyzeAll(mesh, settings) {
        const bbox = STLParser.computeBoundingBox(mesh.vertices);
        const volume = STLParser.computeVolume(mesh.triangles);
        const surfaceArea = STLParser.computeSurfaceArea(mesh.triangles);

        const enrichedMesh = {
            ...mesh,
            bbox,
            volume,
            surfaceArea
        };

        const results = [];
        let totalScore = 0;
        let maxPossibleScore = 0;

        for (const analyzer of registry) {
            const points = settings.bareme[analyzer.id] ?? analyzer.defaultPoints;
            maxPossibleScore += points;

            try {
                const result = analyzer.analyze(enrichedMesh, settings);
                const scored = result.pass ? points : 0;
                totalScore += scored;

                results.push({
                    id: analyzer.id,
                    label: analyzer.label,
                    pass: result.pass,
                    score: scored,
                    maxScore: points,
                    message: result.message,
                    severity: result.severity || (result.pass ? 'success' : 'error'),
                    detail: result.detail || null
                });
            } catch (err) {
                results.push({
                    id: analyzer.id,
                    label: analyzer.label,
                    pass: false,
                    score: 0,
                    maxScore: points,
                    message: `Erreur d'analyse : ${err.message}`,
                    severity: 'error'
                });
            }
        }

        return {
            mesh: enrichedMesh,
            checks: results,
            totalScore,
            maxPossibleScore,
            bbox,
            volume,
            surfaceArea,
            triangleCount: mesh.triangleCount,
            format: mesh.format || 'Inconnu'
        };
    }

    // ======================================================
    // Built-in Analyzers
    // ======================================================

    // 1. Dimension check — does it fit the build volume?
    register({
        id: 'dimensions',
        label: 'Dimensions',
        description: 'Vérifie si l\'objet rentre dans le volume d\'impression (toutes orientations)',
        defaultPoints: 3,
        analyze(mesh, settings) {
            const { bbox } = mesh;
            if (!bbox) return { pass: false, message: 'Impossible de calculer les dimensions', severity: 'error' };

            const objDims = [bbox.size.x, bbox.size.y, bbox.size.z].sort((a, b) => a - b);
            const maxDims = [settings.maxX, settings.maxY, settings.maxZ].sort((a, b) => a - b);

            // Check if object fits in any orientation (sorted comparison)
            const fits = objDims[0] <= maxDims[0] && objDims[1] <= maxDims[1] && objDims[2] <= maxDims[2];

            const dimStr = `${bbox.size.x.toFixed(1)} × ${bbox.size.y.toFixed(1)} × ${bbox.size.z.toFixed(1)} mm`;

            if (fits) {
                return {
                    pass: true,
                    message: `Dimensions OK (${dimStr})`,
                    severity: 'success',
                    detail: dimStr
                };
            } else {
                return {
                    pass: false,
                    message: `L'objet (${dimStr}) dépasse le volume maximum (${settings.maxX}×${settings.maxY}×${settings.maxZ} mm)`,
                    severity: 'error',
                    detail: dimStr
                };
            }
        }
    });

    // 2. Triangle count sanity
    register({
        id: 'triangleCount',
        label: 'Triangles',
        description: 'Vérifie que le modèle contient un nombre raisonnable de triangles',
        defaultPoints: 3,
        analyze(mesh, settings) {
            const count = mesh.triangleCount;

            if (count === 0) {
                return { pass: false, message: 'Le fichier ne contient aucun triangle', severity: 'error' };
            }
            if (count < 4) {
                return { pass: false, message: `Seulement ${count} triangle(s) — modèle incomplet`, severity: 'error' };
            }
            if (count > 5000000) {
                return {
                    pass: false,
                    message: `${count.toLocaleString('fr')} triangles — modèle trop complexe pour l'impression, simplifiez-le`,
                    severity: 'warning'
                };
            }
            return {
                pass: true,
                message: `${count.toLocaleString('fr')} triangles`,
                severity: 'success'
            };
        }
    });

    // 3. Volume check (non-zero, positive)
    register({
        id: 'volume',
        label: 'Volume',
        description: 'Vérifie que le modèle a un volume positif (n\'est pas plat)',
        defaultPoints: 3,
        analyze(mesh, settings) {
            const vol = mesh.volume;

            if (vol < 0.001) {
                return {
                    pass: false,
                    message: 'Volume quasi nul — l\'objet est probablement plat ou non fermé',
                    severity: 'error'
                };
            }

            const volStr = vol < 1000
                ? `${vol.toFixed(2)} mm³`
                : `${(vol / 1000).toFixed(2)} cm³`;

            return {
                pass: true,
                message: `Volume : ${volStr}`,
                severity: 'success'
            };
        }
    });

    // 4. Manifold / Watertight check (edge analysis)
    register({
        id: 'manifold',
        label: 'Manifold (étanchéité)',
        description: 'Vérifie que le maillage est fermé (chaque arête est partagée par exactement 2 triangles)',
        defaultPoints: 3,
        analyze(mesh, settings) {
            // Build edge map
            const edgeMap = new Map();
            let totalEdges = 0;

            for (const tri of mesh.triangles) {
                const verts = tri.vertices;
                for (let i = 0; i < 3; i++) {
                    const a = verts[i];
                    const b = verts[(i + 1) % 3];
                    const key = edgeKey(a, b);
                    edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
                    totalEdges++;
                }
            }

            let boundaryEdges = 0;
            let nonManifoldEdges = 0;

            for (const [, count] of edgeMap) {
                if (count === 1) boundaryEdges++;
                if (count > 2) nonManifoldEdges++;
            }

            if (boundaryEdges === 0 && nonManifoldEdges === 0) {
                return {
                    pass: true,
                    message: 'Maillage fermé (manifold) ✓',
                    severity: 'success'
                };
            }

            const issues = [];
            if (boundaryEdges > 0) issues.push(`${boundaryEdges} arête(s) ouverte(s)`);
            if (nonManifoldEdges > 0) issues.push(`${nonManifoldEdges} arête(s) non-manifold`);

            return {
                pass: false,
                message: `Maillage non étanche : ${issues.join(', ')}. Réparez le modèle avant impression.`,
                severity: 'error'
            };
        }
    });

    // 5. Degenerate triangles check
    register({
        id: 'degenerate',
        label: 'Triangles dégénérés',
        description: 'Détecte les triangles de surface nulle (sommets colinéaires ou confondus)',
        defaultPoints: 3,
        analyze(mesh, settings) {
            let degenerateCount = 0;
            const EPSILON = 1e-10;

            for (const tri of mesh.triangles) {
                const [v1, v2, v3] = tri.vertices;
                // Compute area via cross product
                const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
                const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
                const cx = ay * bz - az * by;
                const cy = az * bx - ax * bz;
                const cz = ax * by - ay * bx;
                const area = Math.sqrt(cx * cx + cy * cy + cz * cz) / 2.0;

                if (area < EPSILON) degenerateCount++;
            }

            if (degenerateCount === 0) {
                return {
                    pass: true,
                    message: 'Aucun triangle dégénéré détecté',
                    severity: 'success'
                };
            }

            const pct = ((degenerateCount / mesh.triangleCount) * 100).toFixed(1);
            return {
                pass: false,
                message: `${degenerateCount} triangle(s) dégénéré(s) (${pct}%) — nettoyez le maillage`,
                severity: degenerateCount > mesh.triangleCount * 0.01 ? 'error' : 'warning'
            };
        }
    });

    // 6. Normals consistency
    register({
        id: 'normals',
        label: 'Normales',
        description: 'Vérifie la cohérence des normales (orientation des faces)',
        defaultPoints: 3,
        analyze(mesh, settings) {
            let flippedCount = 0;
            let zeroNormals = 0;

            for (const tri of mesh.triangles) {
                const [v1, v2, v3] = tri.vertices;
                const n = tri.normal;

                // Compute expected normal from vertices
                const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
                const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
                const cx = ay * bz - az * by;
                const cy = az * bx - ax * bz;
                const cz = ax * by - ay * bx;

                const magComputed = Math.sqrt(cx * cx + cy * cy + cz * cz);
                const magNormal = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);

                if (magNormal < 1e-10) {
                    zeroNormals++;
                    continue;
                }

                if (magComputed < 1e-10) continue; // degenerate triangle

                // Dot product between stored normal and computed normal
                const dot = (n.x * cx + n.y * cy + n.z * cz) / (magNormal * magComputed);
                if (dot < 0) flippedCount++;
            }

            const total = mesh.triangleCount;
            if (flippedCount === 0 && zeroNormals === 0) {
                return {
                    pass: true,
                    message: 'Normales cohérentes ✓',
                    severity: 'success'
                };
            }

            const issues = [];
            if (flippedCount > 0) issues.push(`${flippedCount} normale(s) inversée(s)`);
            if (zeroNormals > 0) issues.push(`${zeroNormals} normale(s) nulle(s)`);

            const pct = (((flippedCount + zeroNormals) / total) * 100).toFixed(1);
            const isMinor = (flippedCount + zeroNormals) < total * 0.05;

            return {
                pass: isMinor,
                message: `${issues.join(', ')} (${pct}%)${isMinor ? ' — mineur, peut être ignoré' : ' — recalculez les normales'}`,
                severity: isMinor ? 'warning' : 'error'
            };
        }
    });

    // ======================================================
    // Helper: create a canonical edge key from two vertices
    // ======================================================
    function edgeKey(a, b) {
        // Round to avoid floating point issues
        const precision = 100000;
        const ax = Math.round(a.x * precision);
        const ay = Math.round(a.y * precision);
        const az = Math.round(a.z * precision);
        const bx = Math.round(b.x * precision);
        const by = Math.round(b.y * precision);
        const bz = Math.round(b.z * precision);

        // Canonical order
        const keyA = `${ax},${ay},${az}`;
        const keyB = `${bx},${by},${bz}`;
        return keyA < keyB ? `${keyA}-${keyB}` : `${keyB}-${keyA}`;
    }

    return { register, getAll, analyzeAll };
})();
