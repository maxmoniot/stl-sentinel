/**
 * STL Sentinel — Main Application
 * Supports STL + OBJ, 3D thumbnails & interactive viewer
 */

(() => {
    'use strict';

    // ======================================================
    // Settings
    // ======================================================
    const DEFAULT_SETTINGS = { maxX: 220, maxY: 220, maxZ: 250, bareme: {}, dimPoints: 3, dimPenaltyEnabled: false, dimPenaltyPerMm: 0.5 };

    function loadSettings() {
        try {
            const saved = localStorage.getItem('stl-sentinel-settings');
            if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        } catch (e) { /* ignore */ }
        return { ...DEFAULT_SETTINGS };
    }
    function saveSettings(s) { localStorage.setItem('stl-sentinel-settings', JSON.stringify(s)); }

    let settings = loadSettings();
    settings.bareme.dimensions = settings.dimPoints || 3;
    let analysisResults = []; // each entry also has .mesh with triangles

    // ======================================================
    // DOM
    // ======================================================
    const $ = (sel) => document.querySelector(sel);

    const dropzone = $('#dropzone');
    const dropzoneWrapper = $('#dropzone-wrapper');
    const fileInput = $('#file-input');
    const progressSection = $('#progress-section');
    const progressBar = $('#progress-bar');
    const progressText = $('#progress-text');
    const resultsSection = $('#results-section');
    const resultsSummary = $('#results-summary');
    const resultsList = $('#results-list');
    const helpOverlay = $('#help-overlay');
    const supportOverlay = $('#support-overlay');
    const dimX = $('#dim-x');
    const dimY = $('#dim-y');
    const dimZ = $('#dim-z');
    const dimPenaltyToggle = $('#dim-penalty-toggle');
    const dimPenaltyConfig = $('#dim-penalty-config');
    const dimPenaltyValue = $('#dim-penalty-value');
    const dimPointsInput = $('#dim-points');

    // ======================================================
    // Dimensions + Penalty
    // ======================================================
    dimX.value = settings.maxX;
    dimY.value = settings.maxY;
    dimZ.value = settings.maxZ;
    dimPointsInput.value = settings.dimPoints;
    dimPenaltyToggle.checked = settings.dimPenaltyEnabled;
    dimPenaltyValue.value = settings.dimPenaltyPerMm;
    if (settings.dimPenaltyEnabled) dimPenaltyConfig.classList.remove('hidden');

    function readDimSettings() {
        settings.maxX = parseInt(dimX.value) || 220;
        settings.maxY = parseInt(dimY.value) || 220;
        settings.maxZ = parseInt(dimZ.value) || 250;
        settings.dimPoints = parseFloat(dimPointsInput.value) || 3;
        settings.bareme.dimensions = settings.dimPoints;
        settings.dimPenaltyEnabled = dimPenaltyToggle.checked;
        settings.dimPenaltyPerMm = parseFloat(dimPenaltyValue.value) || 0.5;
        saveSettings(settings);
        showReanalyzeIfNeeded();
    }
    [dimX, dimY, dimZ].forEach(input => {
        input.addEventListener('change', readDimSettings);
        input.addEventListener('input', () => { input.value = input.value.replace(/[^0-9]/g, ''); });
    });

    dimPointsInput.addEventListener('change', readDimSettings);
    dimPointsInput.addEventListener('input', () => {
        dimPointsInput.value = dimPointsInput.value.replace(',', '.').replace(/[^0-9.]/g, '');
    });

    dimPenaltyToggle.addEventListener('change', () => {
        if (dimPenaltyToggle.checked) {
            dimPenaltyConfig.classList.remove('hidden');
        } else {
            dimPenaltyConfig.classList.add('hidden');
        }
        readDimSettings();
    });

    dimPenaltyValue.addEventListener('change', readDimSettings);
    dimPenaltyValue.addEventListener('input', () => {
        // Allow digits and one dot/comma
        dimPenaltyValue.value = dimPenaltyValue.value.replace(',', '.').replace(/[^0-9.]/g, '');
    });

    // ======================================================
    // Modals
    // ======================================================
    function openHelp() { helpOverlay.classList.add('active'); }
    function closeHelp() { helpOverlay.classList.remove('active'); }
    function openSupport() { supportOverlay.classList.add('active'); }
    function closeSupport() { supportOverlay.classList.remove('active'); }

    // ======================================================
    // 3D Rendering Helpers (Three.js)
    // ======================================================

    /**
     * Build a Three.js BufferGeometry from parsed triangles array
     */
    function buildGeometry(triangles) {
        const positions = new Float32Array(triangles.length * 9);
        const normals = new Float32Array(triangles.length * 9);
        let pi = 0, ni = 0;

        for (const tri of triangles) {
            for (const v of tri.vertices) {
                positions[pi++] = v.x;
                positions[pi++] = v.y;
                positions[pi++] = v.z;
            }
            normals[ni++] = tri.normal.x; normals[ni++] = tri.normal.y; normals[ni++] = tri.normal.z;
            normals[ni++] = tri.normal.x; normals[ni++] = tri.normal.y; normals[ni++] = tri.normal.z;
            normals[ni++] = tri.normal.x; normals[ni++] = tri.normal.y; normals[ni++] = tri.normal.z;
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geom.computeBoundingSphere();
        return geom;
    }

    /**
     * Render a static thumbnail into a canvas
     */
    function renderThumbnail(canvas, triangles) {
        const size = 128; // render at 2x for retina
        canvas.width = size;
        canvas.height = size;

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setSize(size, size, false);
        renderer.setClearColor(0x0f1117, 1);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);

        // Lights
        scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(1, 2, 3);
        scene.add(dirLight);

        const geom = buildGeometry(triangles);
        const mat = new THREE.MeshPhongMaterial({
            color: 0x6ee7b7,
            specular: 0x333333,
            shininess: 30,
            flatShading: true
        });
        const mesh = new THREE.Mesh(geom, mat);

        // STL/OBJ: Z-up → Three.js Y-up
        mesh.rotation.x = -Math.PI / 2;

        // Center and fit (accounting for -90° X rotation)
        geom.computeBoundingBox();
        const box = geom.boundingBox;
        const rawCenter = new THREE.Vector3();
        box.getCenter(rawCenter);
        const center = new THREE.Vector3(rawCenter.x, -rawCenter.z, rawCenter.y);
        mesh.position.set(-center.x, -center.y, -center.z);
        scene.add(mesh);

        const sizeX = box.max.x - box.min.x;
        const sizeY = box.max.z - box.min.z;
        const sizeZ = box.max.y - box.min.y;
        const maxDim = Math.max(sizeX, sizeY, sizeZ);
        const dist = maxDim * 1.8;
        camera.position.set(dist * 0.6, dist * 0.5, dist * 0.8);
        camera.lookAt(0, 0, 0);

        renderer.render(scene, camera);

        // Cleanup
        geom.dispose();
        mat.dispose();
        renderer.dispose();
    }

    /**
     * Create an interactive 3D viewer with orbit controls (manual implementation)
     */
    function createViewer(container, triangles) {
        const rect = container.getBoundingClientRect();
        const w = rect.width || 400;
        const h = rect.height || 280;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(w, h);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(0x0f1117, 1);
        container.prepend(renderer.domElement);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 50000);

        // Grid
        const gridHelper = new THREE.GridHelper(500, 20, 0x2a3040, 0x1a1e28);
        scene.add(gridHelper);

        // Lights
        scene.add(new THREE.AmbientLight(0xffffff, 0.45));
        const dir1 = new THREE.DirectionalLight(0xffffff, 0.7);
        dir1.position.set(2, 4, 3);
        scene.add(dir1);
        const dir2 = new THREE.DirectionalLight(0x6ee7b7, 0.3);
        dir2.position.set(-3, 1, -2);
        scene.add(dir2);

        const geom = buildGeometry(triangles);
        const mat = new THREE.MeshPhongMaterial({
            color: 0x6ee7b7,
            specular: 0x444444,
            shininess: 40,
            flatShading: true
        });
        const meshObj = new THREE.Mesh(geom, mat);

        // STL/OBJ: Z-up → Three.js Y-up
        meshObj.rotation.x = -Math.PI / 2;

        geom.computeBoundingBox();
        const box = geom.boundingBox;
        // Apply rotation to bounding box center
        const rawCenter = new THREE.Vector3();
        box.getCenter(rawCenter);
        // Rotate center like the mesh (-90° X)
        const center = new THREE.Vector3(rawCenter.x, -rawCenter.z, rawCenter.y);
        meshObj.position.set(-center.x, -center.y, -center.z);

        scene.add(meshObj);

        // Rotated dimensions
        const sizeX = box.max.x - box.min.x;
        const sizeY = box.max.z - box.min.z; // Z becomes Y after rotation
        const sizeZ = box.max.y - box.min.y; // Y becomes Z after rotation
        const maxDim = Math.max(sizeX, sizeY, sizeZ);

        // Position grid at bottom of rotated object
        const bottomY = -center.y - sizeY / 2;
        gridHelper.position.y = bottomY;
        let camDist = maxDim * 2.2;

        // Spherical coords for orbit
        let theta = Math.PI / 4;   // horizontal angle
        let phi = Math.PI / 3;     // vertical angle (from top)
        let targetTheta = theta;
        let targetPhi = phi;
        let targetDist = camDist;

        function updateCamera() {
            // Smooth interpolation
            theta += (targetTheta - theta) * 0.1;
            phi += (targetPhi - phi) * 0.1;
            camDist += (targetDist - camDist) * 0.1;

            phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));

            camera.position.x = camDist * Math.sin(phi) * Math.cos(theta);
            camera.position.y = camDist * Math.cos(phi);
            camera.position.z = camDist * Math.sin(phi) * Math.sin(theta);
            camera.lookAt(0, 0, 0);
        }

        // Mouse controls
        let isDragging = false;
        let lastX = 0, lastY = 0;

        renderer.domElement.addEventListener('mousedown', (e) => {
            isDragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            targetTheta += dx * 0.008;
            targetPhi -= dy * 0.008;
        });

        window.addEventListener('mouseup', () => { isDragging = false; });

        // Touch controls
        let lastTouch = null;
        let lastTouchDist = 0;

        renderer.domElement.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            } else if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                lastTouchDist = Math.sqrt(dx * dx + dy * dy);
            }
        }, { passive: true });

        renderer.domElement.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1 && lastTouch) {
                const dx = e.touches[0].clientX - lastTouch.x;
                const dy = e.touches[0].clientY - lastTouch.y;
                lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                targetTheta += dx * 0.008;
                targetPhi -= dy * 0.008;
            } else if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (lastTouchDist > 0) {
                    const scale = lastTouchDist / dist;
                    targetDist *= scale;
                    targetDist = Math.max(maxDim * 0.5, Math.min(maxDim * 10, targetDist));
                }
                lastTouchDist = dist;
            }
        }, { passive: true });

        renderer.domElement.addEventListener('touchend', () => {
            lastTouch = null;
            lastTouchDist = 0;
        }, { passive: true });

        // Zoom
        renderer.domElement.addEventListener('wheel', (e) => {
            e.preventDefault();
            targetDist *= e.deltaY > 0 ? 1.1 : 0.9;
            targetDist = Math.max(maxDim * 0.5, Math.min(maxDim * 10, targetDist));
        }, { passive: false });

        // Animation loop
        let animId;
        function animate() {
            animId = requestAnimationFrame(animate);
            updateCamera();
            renderer.render(scene, camera);
        }
        animate();

        // Resize observer
        const resizeObs = new ResizeObserver(entries => {
            const { width: nw, height: nh } = entries[0].contentRect;
            if (nw > 0 && nh > 0) {
                renderer.setSize(nw, nh);
                camera.aspect = nw / nh;
                camera.updateProjectionMatrix();
            }
        });
        resizeObs.observe(container);

        // Return cleanup function
        return () => {
            cancelAnimationFrame(animId);
            resizeObs.disconnect();
            geom.dispose();
            mat.dispose();
            renderer.dispose();
        };
    }

    // ======================================================
    // Reanalyze
    // ======================================================
    const btnReanalyze = $('#btn-reanalyze');

    function showReanalyzeIfNeeded() {
        if (analysisResults.length > 0) {
            btnReanalyze.classList.remove('hidden');
        }
    }

    function reanalyze() {
        readDimSettings();
        // Re-run analysis on stored triangles
        const reanalyzed = analysisResults.map(r => {
            if (!r._triangles) return r; // error entries stay as-is
            try {
                const mesh = { triangles: r._triangles, vertices: [], triangleCount: r._triangles.length, format: r.format };
                // Rebuild vertices from triangles
                for (const tri of r._triangles) {
                    for (const v of tri.vertices) mesh.vertices.push(v);
                }
                const analysis = STLAnalyzers.analyzeAll(mesh, settings);
                analysis.fileName = r.fileName;
                analysis.fileSize = r.fileSize;
                analysis._triangles = r._triangles;
                return analysis;
            } catch (err) {
                return r;
            }
        });
        analysisResults = reanalyzed;
        btnReanalyze.classList.add('hidden');
        renderResults();
    }

    // ======================================================
    // File Handling
    // ======================================================
    function handleFiles(files) {
        const validFiles = Array.from(files).filter(f => {
            const ext = f.name.toLowerCase();
            return ext.endsWith('.stl') || ext.endsWith('.obj');
        });

        if (validFiles.length === 0) {
            alert('Aucun fichier .stl ou .obj détecté.');
            return;
        }

        readDimSettings();
        processFiles(validFiles);
    }

    async function processFiles(files) {
        progressSection.classList.remove('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = `Analyse de ${files.length} fichier(s)…`;

        const newResults = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            progressText.textContent = `Analyse de ${file.name} (${i + 1}/${files.length})…`;
            progressBar.style.width = `${((i) / files.length) * 100}%`;

            try {
                const buffer = await readFile(file);
                const mesh = STLParser.parse(buffer, file.name);
                const analysis = STLAnalyzers.analyzeAll(mesh, settings);
                analysis.fileName = file.name;
                analysis.fileSize = file.size;
                // Keep triangles for 3D rendering
                analysis._triangles = mesh.triangles;
                newResults.push(analysis);
            } catch (err) {
                newResults.push({
                    fileName: file.name,
                    fileSize: file.size,
                    error: err.message,
                    checks: [],
                    totalScore: 0,
                    maxPossibleScore: 0,
                    triangleCount: 0,
                    _triangles: null
                });
            }

            await sleep(50);
        }

        progressBar.style.width = '100%';
        progressText.textContent = 'Analyse terminée !';

        await sleep(400);
        progressSection.classList.add('hidden');

        analysisResults = [...analysisResults, ...newResults];
        renderResults();
    }

    function readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error(`Impossible de lire ${file.name}`));
            reader.readAsArrayBuffer(file);
        });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ======================================================
    // Render Results
    // ======================================================
    // Track active viewers for cleanup
    const activeViewers = new Map();

    function renderResults() {
        // Cleanup existing viewers
        for (const cleanup of activeViewers.values()) cleanup();
        activeViewers.clear();

        if (analysisResults.length === 0) {
            resultsSection.classList.add('hidden');
            dropzoneWrapper.classList.remove('compact');
            return;
        }

        resultsSection.classList.remove('hidden');
        dropzoneWrapper.classList.add('compact');

        const total = analysisResults.length;
        const passed = analysisResults.filter(r => !r.error && r.totalScore === r.maxPossibleScore).length;
        const withIssues = total - passed;

        resultsSummary.innerHTML = `
            <div class="summary-stat">
                <span class="stat-value">${total}</span>
                <span class="stat-label">Fichier${total > 1 ? 's' : ''} analysé${total > 1 ? 's' : ''}</span>
            </div>
            <div class="summary-stat">
                <span class="stat-value" style="color: var(--success)">${passed}</span>
                <span class="stat-label">Conforme${passed > 1 ? 's' : ''}</span>
            </div>
            <div class="summary-stat">
                <span class="stat-value" style="color: ${withIssues > 0 ? 'var(--error)' : 'var(--text-muted)'}">${withIssues}</span>
                <span class="stat-label">Avec correction${withIssues > 1 ? 's' : ''}</span>
            </div>
        `;

        resultsList.innerHTML = '';
        analysisResults.forEach((result, idx) => {
            resultsList.appendChild(createResultCard(result, idx));
        });
    }

    function createResultCard(result, idx) {
        const card = document.createElement('div');
        card.className = 'result-card';

        const isError = !!result.error;
        const isPerfect = !isError && result.totalScore === result.maxPossibleScore;
        const scoreRatio = isError ? 0 : result.totalScore / result.maxPossibleScore;

        let statusClass, scoreClass;
        if (isError) { statusClass = 'fail'; scoreClass = 'bad'; }
        else if (isPerfect) { statusClass = 'pass'; scoreClass = 'perfect'; }
        else if (scoreRatio >= 0.5) { statusClass = 'warn'; scoreClass = 'good'; }
        else { statusClass = 'fail'; scoreClass = 'bad'; }

        let dimsStr = '';
        if (result.bbox) {
            const s = result.bbox.size;
            dimsStr = `${s.x.toFixed(1)}×${s.y.toFixed(1)}×${s.z.toFixed(1)} mm`;
        }

        // Thumbnail canvas
        const thumbHtml = result._triangles
            ? `<div class="result-thumbnail"><canvas id="thumb-${idx}"></canvas></div>`
            : '';

        card.innerHTML = `
            <div class="result-card-header">
                ${thumbHtml}
                <div class="result-status-dot ${statusClass}"></div>
                <span class="result-filename" title="${result.fileName}">${result.fileName}</span>
                <span class="result-score ${scoreClass}">${isError ? 'ERR' : `${fmtScore(result.totalScore)}/${fmtScore(result.maxPossibleScore)}`}</span>
                ${dimsStr ? `<span class="result-dims">${dimsStr}</span>` : ''}
                <div class="result-toggle">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="6 9 12 15 18 9"/>
                    </svg>
                </div>
            </div>
            <div class="result-details">
                ${result._triangles ? `<div class="viewer3d-container" id="viewer-${idx}"><span class="viewer3d-hint">clic + glisser pour tourner · molette pour zoomer</span></div>` : ''}
                ${isError ? renderErrorDetails(result) : renderAnalysisDetails(result)}
            </div>
        `;

        // Toggle expand — lazy-init 3D viewer
        const header = card.querySelector('.result-card-header');
        let viewerInitialized = false;

        header.addEventListener('click', () => {
            const wasExpanded = card.classList.contains('expanded');
            card.classList.toggle('expanded');

            if (!wasExpanded && !viewerInitialized && result._triangles) {
                viewerInitialized = true;
                const container = card.querySelector(`#viewer-${idx}`);
                if (container) {
                    // Small delay so container has its dimensions
                    requestAnimationFrame(() => {
                        const cleanup = createViewer(container, result._triangles);
                        activeViewers.set(idx, cleanup);
                    });
                }
            }
        });

        // Render thumbnail after insertion
        requestAnimationFrame(() => {
            if (result._triangles) {
                const thumbCanvas = card.querySelector(`#thumb-${idx}`);
                if (thumbCanvas) {
                    try { renderThumbnail(thumbCanvas, result._triangles); }
                    catch (e) { /* silently fail */ }
                }
            }
        });

        return card;
    }

    function renderErrorDetails(result) {
        return `
            <div style="padding-top:16px">
                <div class="correction-item error">
                    <span class="correction-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                        </svg>
                    </span>
                    <span>${result.error}</span>
                </div>
            </div>
        `;
    }

    function renderAnalysisDetails(result) {
        const fileSizeStr = formatFileSize(result.fileSize);
        const volStr = result.volume < 1000
            ? `${result.volume.toFixed(2)} mm³`
            : `${(result.volume / 1000).toFixed(2)} cm³`;
        const areaStr = result.surfaceArea < 1000
            ? `${result.surfaceArea.toFixed(2)} mm²`
            : `${(result.surfaceArea / 100).toFixed(2)} cm²`;

        let html = `<div class="detail-grid">`;
        html += detailItem('Format', result.format);
        html += detailItem('Taille fichier', fileSizeStr);
        html += detailItem('Triangles', result.triangleCount.toLocaleString('fr'));
        html += detailItem('Volume', volStr);
        html += detailItem('Surface', areaStr);
        if (result.bbox) {
            html += detailItem('Dimensions', `${result.bbox.size.x.toFixed(1)} × ${result.bbox.size.y.toFixed(1)} × ${result.bbox.size.z.toFixed(1)} mm`);
        }
        html += `</div>`;

        const failures = result.checks.filter(c => !c.pass);
        const successes = result.checks.filter(c => c.pass);

        if (failures.length > 0) {
            html += `<div class="corrections-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                Corrections nécessaires (${failures.length})
            </div>`;
            html += `<div class="corrections-list">`;
            for (const check of failures) {
                const sev = check.severity === 'warning' ? 'warning' : 'error';
                const icon = sev === 'warning'
                    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
                    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
                html += `
                    <div class="correction-item ${sev}">
                        <span class="correction-icon">${icon}</span>
                        <span><strong>${check.label}</strong> (${fmtScore(check.score)}/${fmtScore(check.maxScore)} pts) — ${check.message}</span>
                    </div>
                `;
            }
            html += `</div>`;
        }

        if (successes.length > 0 && failures.length > 0) {
            html += `<div class="corrections-title" style="margin-top:16px">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
                Critères validés (${successes.length})
            </div>`;
            html += `<div class="corrections-list">`;
            for (const check of successes) {
                html += `
                    <div class="correction-item success">
                        <span class="correction-icon">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="20 6 9 17 4 12"/>
                            </svg>
                        </span>
                        <span><strong>${check.label}</strong> (${fmtScore(check.score)}/${fmtScore(check.maxScore)} pts) — ${check.message}</span>
                    </div>
                `;
            }
            html += `</div>`;
        }

        if (failures.length === 0) {
            html += `
                <div class="no-corrections">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                    Tous les critères sont validés — le fichier est prêt pour l'impression !
                </div>
            `;
        }

        return html;
    }

    function detailItem(label, value) {
        return `<div class="detail-item"><span class="detail-label">${label}</span><span class="detail-value">${value}</span></div>`;
    }

    function fmtScore(n) {
        return n % 1 === 0 ? n.toString() : n.toFixed(1);
    }

    function formatFileSize(bytes) {
        if (bytes < 1024) return `${bytes} o`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} Ko`;
        return `${(bytes / 1048576).toFixed(1)} Mo`;
    }

    // ======================================================
    // CSV Export
    // ======================================================
    function exportCSV() {
        if (analysisResults.length === 0) return;

        const analyzers = STLAnalyzers.getAll();
        const headers = [
            'Fichier', 'Format', 'Taille (octets)', 'Triangles',
            'X (mm)', 'Y (mm)', 'Z (mm)', 'Volume (mm³)', 'Surface (mm²)',
            'Score', 'Score Max',
            ...analyzers.map(a => a.label),
            'Corrections'
        ];

        const rows = analysisResults.map(r => {
            const dims = r.bbox ? r.bbox.size : { x: 0, y: 0, z: 0 };
            const checkMap = {};
            for (const c of r.checks) checkMap[c.id] = c;
            const corrections = r.checks.filter(c => !c.pass).map(c => `${c.label}: ${c.message}`).join(' | ');
            return [
                r.fileName, r.format || 'N/A', r.fileSize, r.triangleCount,
                dims.x.toFixed(1), dims.y.toFixed(1), dims.z.toFixed(1),
                (r.volume || 0).toFixed(2), (r.surfaceArea || 0).toFixed(2),
                r.totalScore, r.maxPossibleScore,
                ...analyzers.map(a => { const c = checkMap[a.id]; return c ? (c.pass ? '✓' : '✗') : 'N/A'; }),
                corrections || 'Aucune'
            ];
        });

        let csv = '\ufeff';
        csv += headers.map(h => `"${h}"`).join(';') + '\n';
        for (const row of rows) {
            csv += row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';') + '\n';
        }

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `stl-sentinel-rapport-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ======================================================
    // Event Listeners
    // ======================================================
    $('#btn-help').addEventListener('click', openHelp);
    $('#btn-close-help').addEventListener('click', closeHelp);
    helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) closeHelp(); });

    $('#btn-support').addEventListener('click', openSupport);
    $('#btn-close-support').addEventListener('click', closeSupport);
    supportOverlay.addEventListener('click', (e) => { if (e.target === supportOverlay) closeSupport(); });

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFiles(e.target.files);
        fileInput.value = '';
    });

    ['dragenter', 'dragover'].forEach(evt => {
        dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('drag-over'); });
    });
    ['dragleave', 'drop'].forEach(evt => {
        dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('drag-over'); });
    });
    dropzone.addEventListener('drop', (e) => { if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files); });

    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files); });

    $('#btn-add-more').addEventListener('click', () => fileInput.click());
    $('#btn-export-csv').addEventListener('click', exportCSV);
    btnReanalyze.addEventListener('click', reanalyze);
    $('#btn-clear-all').addEventListener('click', () => {
        for (const cleanup of activeViewers.values()) cleanup();
        activeViewers.clear();
        analysisResults = [];
        renderResults();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeHelp(); closeSupport(); }
    });

})();
