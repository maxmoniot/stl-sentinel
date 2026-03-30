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
            // Skip disabled analyzers
            if (settings.enabledChecks && settings.enabledChecks[analyzer.id] === false) continue;

            const points = settings.bareme[analyzer.id] ?? analyzer.defaultPoints;
            maxPossibleScore += points;

            try {
                const result = analyzer.analyze(enrichedMesh, settings, points);
                // Analyzers can return fractionalScore (0 to points) for partial credit
                // If not provided, fall back to binary pass/fail
                const scored = (result.fractionalScore !== undefined)
                    ? result.fractionalScore
                    : (result.pass ? points : 0);
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

    // 1. Dimension check — test all orientations, partial scoring
    register({
        id: 'dimensions',
        label: 'Dimensions',
        description: 'Vérifie si l\'objet rentre dans le volume d\'impression (toutes orientations)',
        defaultPoints: 3,
        analyze(mesh, settings, maxPoints) {
            const { bbox } = mesh;
            if (!bbox) return { pass: false, message: 'Impossible de calculer les dimensions', severity: 'error' };

            const objDims = [bbox.size.x, bbox.size.y, bbox.size.z];
            const maxDims = [settings.maxX, settings.maxY, settings.maxZ];
            const sortedMax = [...maxDims].sort((a, b) => a - b);

            const useCustomPenalty = settings.dimPenaltyEnabled && settings.dimPenaltyPerMm > 0;
            const ptsPerMm = settings.dimPenaltyPerMm || 0.5;

            // Generate all 6 permutations of object dimensions
            const permutations = [
                [0, 1, 2], [0, 2, 1], [1, 0, 2],
                [1, 2, 0], [2, 0, 1], [2, 1, 0]
            ];

            // For each permutation, compute penalty and keep the best
            let bestPenalty = Infinity;
            let bestInfo = null;

            for (const perm of permutations) {
                const oriented = [objDims[perm[0]], objDims[perm[1]], objDims[perm[2]]];
                const sortedObj = [...oriented].sort((a, b) => a - b);

                let badAxes = 0;
                let totalExcessMm = 0;

                for (let i = 0; i < 3; i++) {
                    const excess = sortedObj[i] - sortedMax[i];
                    if (excess > 0.05) { // 0.05mm tolerance
                        badAxes++;
                        totalExcessMm += excess;
                    }
                }

                // Compute penalty for this orientation
                let penalty;
                if (useCustomPenalty) {
                    // Custom: total mm × points per mm
                    penalty = totalExcessMm * ptsPerMm;
                } else {
                    // Default: 1/3 of maxPoints per bad axis
                    penalty = (maxPoints / 3) * badAxes;
                }

                if (penalty < bestPenalty) {
                    bestPenalty = penalty;
                    bestInfo = { badAxes, totalExcessMm, sortedObj };
                }
            }

            const dimStr = `${bbox.size.x.toFixed(1)} × ${bbox.size.y.toFixed(1)} × ${bbox.size.z.toFixed(1)} mm`;
            const { badAxes, totalExcessMm } = bestInfo;

            // Perfect fit
            if (badAxes === 0) {
                return {
                    pass: true,
                    fractionalScore: maxPoints,
                    message: `Dimensions OK (${dimStr})`,
                    severity: 'success',
                    detail: dimStr
                };
            }

            // Round penalty to 0.5, clamp score to [0, maxPoints]
            const roundedPenalty = Math.round(bestPenalty * 2) / 2;
            const finalScore = Math.max(0, Math.round((maxPoints - roundedPenalty) * 2) / 2);

            const maxStr = `${settings.maxX}×${settings.maxY}×${settings.maxZ}`;

            if (useCustomPenalty) {
                const axisWord = badAxes === 1 ? 'axe' : 'axes';
                return {
                    pass: false,
                    fractionalScore: finalScore,
                    message: `${badAxes} ${axisWord} hors limites — dépassement total ${totalExcessMm.toFixed(1)} mm × ${ptsPerMm} pt/mm = −${roundedPenalty} pt${roundedPenalty > 1 ? 's' : ''} (${dimStr})`,
                    severity: finalScore <= 0 ? 'error' : 'warning',
                    detail: dimStr
                };
            }

            // Default mode
            const axisWord = badAxes === 1 ? 'axe dépasse' : 'axes dépassent';
            return {
                pass: false,
                fractionalScore: finalScore,
                message: `${badAxes} ${axisWord} le volume max ${maxStr} mm (${dimStr}) → −${roundedPenalty} pt${roundedPenalty > 1 ? 's' : ''}`,
                severity: finalScore <= 0 ? 'error' : 'warning',
                detail: dimStr
            };
        }
    });

    // ======================================================
    // 2. Triangle count sanity
    // ======================================================
    register({
        id: 'triangleCount',
        label: 'Nombre de triangles',
        description: 'Vérifie que le modèle contient un nombre raisonnable de triangles (ni trop peu = modèle vide, ni trop = trop complexe à traiter)',
        defaultPoints: 1,
        analyze(mesh, settings) {
            const count = mesh.triangleCount;
            if (count === 0) return { pass: false, message: 'Le fichier ne contient aucun triangle', severity: 'error' };
            if (count < 4) return { pass: false, message: `Seulement ${count} triangle(s) — modèle incomplet`, severity: 'error' };
            if (count > 5000000) {
                return { pass: false, message: `${count.toLocaleString('fr')} triangles — modèle trop complexe pour l'impression, simplifiez-le`, severity: 'warning' };
            }
            return { pass: true, message: `${count.toLocaleString('fr')} triangles`, severity: 'success' };
        }
    });

    // ======================================================
    // 3. Volume check (non-zero, positive)
    // ======================================================
    register({
        id: 'volume',
        label: 'Volume non nul',
        description: 'Vérifie que le modèle a bien un volume (n\'est pas une surface plate ou vide)',
        defaultPoints: 1,
        analyze(mesh, settings) {
            const vol = mesh.volume;
            if (vol < 0.001) {
                return { pass: false, message: 'Volume quasi nul — l\'objet est probablement plat ou non fermé', severity: 'error' };
            }
            const volStr = vol < 1000 ? `${vol.toFixed(2)} mm³` : `${(vol / 1000).toFixed(2)} cm³`;
            return { pass: true, message: `Volume : ${volStr}`, severity: 'success' };
        }
    });

    // ======================================================
    // 4. Manifold / Watertight check (edge analysis)
    // ======================================================
    register({
        id: 'manifold',
        label: 'Maillage fermé (manifold)',
        description: 'Vérifie que le modèle est "étanche" : chaque arête est partagée par exactement 2 faces. Un modèle non-manifold a des trous ou des arêtes flottantes — l\'imprimante ne saurait pas quoi remplir.',
        defaultPoints: 2,
        analyze(mesh, settings) {
            const edgeMap = new Map();
            for (const tri of mesh.triangles) {
                const verts = tri.vertices;
                for (let i = 0; i < 3; i++) {
                    const key = edgeKey(verts[i], verts[(i + 1) % 3]);
                    edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
                }
            }
            let boundaryEdges = 0, nonManifoldEdges = 0;
            for (const [, count] of edgeMap) {
                if (count === 1) boundaryEdges++;
                if (count > 2) nonManifoldEdges++;
            }
            if (boundaryEdges === 0 && nonManifoldEdges === 0) {
                return { pass: true, message: 'Maillage fermé (manifold) ✓', severity: 'success' };
            }
            const issues = [];
            if (boundaryEdges > 0) issues.push(`${boundaryEdges} arête(s) ouverte(s)`);
            if (nonManifoldEdges > 0) issues.push(`${nonManifoldEdges} arête(s) non-manifold`);
            return { pass: false, message: `Maillage non étanche : ${issues.join(', ')} — réparez le modèle avant impression`, severity: 'error' };
        }
    });

    // ======================================================
    // 5. Degenerate triangles check
    // ======================================================
    register({
        id: 'degenerate',
        label: 'Triangles valides',
        description: 'Détecte les triangles "dégénérés" (surface nulle, sommets confondus ou alignés) qui peuvent poser problème à l\'imprimante ou au slicer.',
        defaultPoints: 1,
        analyze(mesh, settings) {
            let degenerateCount = 0;
            const EPSILON = 1e-10;
            for (const tri of mesh.triangles) {
                const [v1, v2, v3] = tri.vertices;
                const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
                const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
                const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
                if (Math.sqrt(cx*cx + cy*cy + cz*cz) / 2 < EPSILON) degenerateCount++;
            }
            if (degenerateCount === 0) return { pass: true, message: 'Aucun triangle dégénéré ✓', severity: 'success' };
            const pct = ((degenerateCount / mesh.triangleCount) * 100).toFixed(1);
            return {
                pass: false,
                message: `${degenerateCount} triangle(s) dégénéré(s) (${pct}%) — nettoyez le maillage`,
                severity: degenerateCount > mesh.triangleCount * 0.01 ? 'error' : 'warning'
            };
        }
    });

    // ======================================================
    // 6. Normals consistency
    // ======================================================
    register({
        id: 'normals',
        label: 'Normales cohérentes',
        description: 'Vérifie que toutes les faces "regardent" vers l\'extérieur du modèle. Des normales inversées indiquent que l\'intérieur et l\'extérieur sont confondus — le slicer peut mal calculer les parois.',
        defaultPoints: 1,
        analyze(mesh, settings) {
            let flippedCount = 0, zeroNormals = 0;
            for (const tri of mesh.triangles) {
                const [v1, v2, v3] = tri.vertices;
                const n = tri.normal;
                const ax = v2.x-v1.x, ay = v2.y-v1.y, az = v2.z-v1.z;
                const bx = v3.x-v1.x, by = v3.y-v1.y, bz = v3.z-v1.z;
                const cx = ay*bz-az*by, cy = az*bx-ax*bz, cz = ax*by-ay*bx;
                const magC = Math.sqrt(cx*cx+cy*cy+cz*cz);
                const magN = Math.sqrt(n.x*n.x+n.y*n.y+n.z*n.z);
                if (magN < 1e-10) { zeroNormals++; continue; }
                if (magC < 1e-10) continue;
                if ((n.x*cx+n.y*cy+n.z*cz)/(magN*magC) < 0) flippedCount++;
            }
            const total = mesh.triangleCount;
            if (flippedCount === 0 && zeroNormals === 0) return { pass: true, message: 'Normales cohérentes ✓', severity: 'success' };
            const issues = [];
            if (flippedCount > 0) issues.push(`${flippedCount} normale(s) inversée(s)`);
            if (zeroNormals > 0) issues.push(`${zeroNormals} normale(s) nulle(s)`);
            const pct = (((flippedCount+zeroNormals)/total)*100).toFixed(1);
            const isMinor = (flippedCount+zeroNormals) < total*0.05;
            return {
                pass: isMinor,
                message: `${issues.join(', ')} (${pct}%)${isMinor ? ' — mineur, peut être ignoré' : ' — recalculez les normales'}`,
                severity: isMinor ? 'warning' : 'error'
            };
        }
    });

    // ======================================================
    // 7. Connected components (formes orphelines)
    // ======================================================
    register({
        id: 'connected',
        label: 'Objet unique (pas de formes orphelines)',
        description: 'Vérifie que le modèle est un seul solide d\'un seul tenant. Des "formes orphelines" sont des morceaux flottants non reliés au reste — ils peuvent être oubliés ou causer des erreurs d\'impression.',
        defaultPoints: 2,
        analyze(mesh, settings) {
            const n = mesh.triangles.length;
            if (n === 0) return { pass: false, message: 'Aucun triangle', severity: 'error' };

            // Union-Find (path-compressed, union by rank)
            const parent = Array.from({ length: n }, (_, i) => i);
            const rank = new Uint8Array(n);
            function find(x) {
                while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
                return x;
            }
            function union(a, b) {
                a = find(a); b = find(b);
                if (a === b) return;
                if (rank[a] < rank[b]) { const t = a; a = b; b = t; }
                parent[b] = a;
                if (rank[a] === rank[b]) rank[a]++;
            }

            // Build vertex → triangle list (using rounded coords as key)
            const PREC = 1e4; // 0.1µm precision
            const vertKey = v => `${Math.round(v.x*PREC)},${Math.round(v.y*PREC)},${Math.round(v.z*PREC)}`;
            const vertToTris = new Map();
            for (let i = 0; i < n; i++) {
                for (const v of mesh.triangles[i].vertices) {
                    const k = vertKey(v);
                    if (!vertToTris.has(k)) vertToTris.set(k, []);
                    vertToTris.get(k).push(i);
                }
            }

            // Union all triangles sharing a vertex
            for (const tris of vertToTris.values()) {
                for (let j = 1; j < tris.length; j++) union(tris[0], tris[j]);
            }

            // Count distinct roots
            const roots = new Set();
            for (let i = 0; i < n; i++) roots.add(find(i));
            const count = roots.size;

            if (count === 1) return { pass: true, message: 'Objet unique ✓', severity: 'success' };
            return {
                pass: false,
                message: `${count} objets distincts détectés — fusionnez les parties non reliées avant impression`,
                severity: 'warning'
            };
        }
    });

    // ======================================================
    // 8. Overhang / Sans supports
    // ======================================================
    register({
        id: 'overhang',
        label: 'Impression sans supports',
        description: 'Détecte les zones en surplomb (faces qui "regardent" vers le bas) qui nécessiteraient des supports pour être imprimées. Le seuil d\'angle est configurable (45° par défaut).',
        defaultPoints: 2,
        analyze(mesh, settings) {
            const angleDeg = settings.overhangAngle ?? 45;
            const cosThreshold = Math.cos((angleDeg * Math.PI) / 180);

            // Find the minimum Z of the whole mesh (= build plate level in STL Z-up)
            let minZ = Infinity;
            for (const tri of mesh.triangles) {
                for (const v of tri.vertices) {
                    if (v.z < minZ) minZ = v.z;
                }
            }
            // Tolerance: 0.1% of total Z range, min 0.05 mm
            let maxZ = -Infinity;
            for (const tri of mesh.triangles) {
                for (const v of tri.vertices) {
                    if (v.z > maxZ) maxZ = v.z;
                }
            }
            const zRange = maxZ - minZ;
            const baseTol = Math.max(0.05, zRange * 0.001);

            let overhangArea = 0, totalArea = 0;

            for (const tri of mesh.triangles) {
                const [v1, v2, v3] = tri.vertices;
                const ax = v2.x-v1.x, ay = v2.y-v1.y, az = v2.z-v1.z;
                const bx = v3.x-v1.x, by = v3.y-v1.y, bz = v3.z-v1.z;
                const cx = ay*bz-az*by, cy = az*bx-ax*bz, cz = ax*by-ay*bx;
                const area = Math.sqrt(cx*cx+cy*cy+cz*cz) / 2;
                totalArea += area;

                if (area > 0) {
                    const mag = Math.sqrt(cx*cx+cy*cy+cz*cz);
                    const nz = cz / mag;

                    if (nz < -cosThreshold) {
                        // Exclude faces that sit on the build plate:
                        // all 3 vertices within baseTol of minZ → this is the floor face
                        const onBase = v1.z <= minZ + baseTol
                                    && v2.z <= minZ + baseTol
                                    && v3.z <= minZ + baseTol;
                        if (!onBase) {
                            overhangArea += area;
                        }
                    }
                }
            }

            if (totalArea === 0) return { pass: false, message: 'Impossible de calculer les surfaces', severity: 'error' };

            const pct = (overhangArea / totalArea) * 100;

            if (overhangArea < 1) {
                return { pass: true, message: `Aucun surplomb ✓ (seuil ${angleDeg}°)`, severity: 'success' };
            }
            if (pct < 5) {
                return {
                    pass: true,
                    message: `Surplombs mineurs : ${overhangArea.toFixed(0)} mm² (${pct.toFixed(1)}%) — probablement imprimable sans supports`,
                    severity: 'warning'
                };
            }
            return {
                pass: false,
                message: `${overhangArea.toFixed(0)} mm² en surplomb (${pct.toFixed(1)}%) > ${angleDeg}° — supports probablement nécessaires`,
                severity: pct > 20 ? 'error' : 'warning'
            };
        }
    });

    // ======================================================
    // Helper: canonical edge key from two vertices
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
