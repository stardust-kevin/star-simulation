/**
 * Star Simulation - 3D Printer Model (Extruder, Nozzle, Fans)
 * This file is solely responsible for the physical rendering of the extruder head.
 */

const PrinterModel = (function () {
    const nozzleGroup = new THREE.Group();

    // --- Materials ---
    const nozzleMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.3, metalness: 0.7 });

    const fanMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.5, metalness: 0.2 });
    const rotorMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.5, metalness: 0.1 });

    // --- Nozzle Geometry (Using your exact parameters) ---
    const blockGeo = new THREE.CylinderGeometry(3, 3, 5, 6);
    const blockMesh = new THREE.Mesh(blockGeo, nozzleMat);
    blockMesh.position.y = 7.5;
    nozzleGroup.add(blockMesh);

    const tipGeo = new THREE.CylinderGeometry(3, 0.4, 5, 6);
    const tipMesh = new THREE.Mesh(tipGeo, nozzleMat);
    tipMesh.position.y = 2.5;
    nozzleGroup.add(tipMesh);

    // --- Refactored Axial Fan Function ---
    function createAxialFan(size) {
        const group = new THREE.Group();
        const r = size / 2;

        // --- 1. Frame ---
        const frameShape = new THREE.Shape();
        const radius = size * 0.15;
        const x = -r, y = -r, w = size, h = size;

        // Draw rounded rectangle
        frameShape.moveTo(x, y + radius);
        frameShape.lineTo(x, y + h - radius);
        frameShape.quadraticCurveTo(x, y + h, x + radius, y + h);
        frameShape.lineTo(x + w - radius, y + h);
        frameShape.quadraticCurveTo(x + w, y + h, x + w, y + h - radius);
        frameShape.lineTo(x + w, y + radius);
        frameShape.quadraticCurveTo(x + w, y, x + w - radius, y);
        frameShape.lineTo(x + radius, y);
        frameShape.quadraticCurveTo(x, y, x, y + radius);

        // Central circular hole ONLY
        const hole = new THREE.Path();
        hole.absarc(0, 0, r * 0.87, 0, Math.PI * 2, true);
        frameShape.holes.push(hole);

        const frameDepth = size * 0.12;
        const frameExtrude = {
            depth: frameDepth,
            bevelEnabled: true,
            bevelSegments: 3,
            steps: 2,
            bevelSize: size * 0.02,
            bevelThickness: size * 0.02,
            curveSegments: 32
        };
        const frameGeo = new THREE.ExtrudeGeometry(frameShape, frameExtrude);
        frameGeo.translate(0, 0, -frameDepth / 2);
        const frameMesh = new THREE.Mesh(frameGeo, fanMat);
        group.add(frameMesh);

        // --- 2. Rotor (Hub + Thin Blades) ---
        const rotor = new THREE.Group();

        // Hub
        const hubRadius = r * 0.25;
        const hubDepth = frameDepth * 1.1;
        const hubGeo = new THREE.CylinderGeometry(hubRadius, hubRadius, hubDepth, 24);
        hubGeo.rotateX(Math.PI / 2);
        const hub = new THREE.Mesh(hubGeo, rotorMat);
        rotor.add(hub);

        // Blades (Thin and smooth)
        const bladeCount = 7;
        const bladeLength = r * 0.55;
        const bladeWidth = r * 0.28;

        const bladeShape = new THREE.Shape();
        const bStart = hubRadius * 0.8;
        const bEnd = hubRadius + bladeLength;

        bladeShape.moveTo(bStart, -bladeWidth * 0.4);
        bladeShape.bezierCurveTo(
            bStart + (bEnd - bStart) * 0.4, -bladeWidth * 0.8,
            bEnd - bladeWidth * 0.2, -bladeWidth * 0.5,
            bEnd, -bladeWidth * 0.1
        );
        bladeShape.quadraticCurveTo(bEnd + bladeWidth * 0.1, 0, bEnd, bladeWidth * 0.1);
        bladeShape.bezierCurveTo(
            bEnd - bladeWidth * 0.2, bladeWidth * 0.5,
            bStart + (bEnd - bStart) * 0.4, bladeWidth * 0.8,
            bStart, bladeWidth * 0.4
        );
        bladeShape.quadraticCurveTo(bStart - bladeWidth * 0.1, 0, bStart, -bladeWidth * 0.4);

        const bladeThickness = size * 0.015;
        const bladeExtrude = { depth: bladeThickness, bevelEnabled: false, curveSegments: 24 };
        const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, bladeExtrude);
        bladeGeo.translate(0, 0, -bladeThickness / 2);

        for (let i = 0; i < bladeCount; i++) {
            const blade = new THREE.Mesh(bladeGeo, rotorMat);
            blade.rotation.x = Math.PI / 4; // 45-degree tilt to prevent clipping

            const wrapper = new THREE.Group();
            wrapper.add(blade);
            wrapper.rotation.z = (i / bladeCount) * Math.PI * 2;
            rotor.add(wrapper);
        }

        group.add(rotor);

        return { group: group, rotor: rotor };
    }

    // Hotend Fan (P1)
    const hotendFan = createAxialFan(14);
    hotendFan.group.position.set(0, 10, -10);
    nozzleGroup.add(hotendFan.group);

    // Model Fan (P0)
    const modelFan = createAxialFan(12);
    modelFan.group.position.set(10, 7, 0);
    modelFan.group.rotation.order = 'YXZ';
    modelFan.group.rotation.y = -Math.PI / 2;
    modelFan.group.rotation.x = Math.PI / 6;
    nozzleGroup.add(modelFan.group);

    // --- Public API ---
    return {
        group: nozzleGroup,

        updateTransform: function (x, y, z) {
            nozzleGroup.position.set(x, z, y);
        },

        setTemperatureVisual: function (currentTemp, ambientTemp) {
            const hotendFactor = Math.max(0, currentTemp - ambientTemp) / 230;
            nozzleMat.color.setRGB(
                0.6 + hotendFactor * 0.4,
                0.6 - hotendFactor * 0.6,
                0.6 - hotendFactor * 0.6
            );
        },

        updateFans: function (dt, p0, p1, maxRpm) {
            if (dt <= 0 || dt > 0.1) return;
            const RPM_TO_RAD = 2 * Math.PI / 60;

            if (modelFan && modelFan.rotor) {
                const omega0 = p0 * maxRpm * RPM_TO_RAD;
                modelFan.rotor.rotation.z -= omega0 * dt;
            }

            if (hotendFan && hotendFan.rotor) {
                const omega1 = p1 * maxRpm * RPM_TO_RAD;
                hotendFan.rotor.rotation.z -= omega1 * dt;
            }
        }
    };
})();

window.PrinterModel = PrinterModel;