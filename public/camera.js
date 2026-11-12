let cameraPc = null;
let cameraWs = null;
let isConnecting = false;
let retryCount = 0;
const MAX_RETRIES = 5;

function startCameraStream() {
    if (isConnecting || (cameraWs && cameraWs.readyState === WebSocket.OPEN)) return;
    const canvas = window.camCanvas;
    if (!canvas) return console.error('[Camera] camCanvas not found.');

    isConnecting = true;
    const stream = canvas.captureStream(30);
    const videoEl = document.getElementById('camera-feed');
    if (videoEl) videoEl.srcObject = stream;

    cameraWs = new WebSocket(`ws://${window.location.host}/camera-signal`);

    cameraWs.onopen = () => {
        isConnecting = false;
        retryCount = 0; // Reset retry count on success
        console.log('[Camera] Signaling connected.');
        createWebRTCPeer(stream);
    };

    cameraWs.onmessage = async (event) => {
        const message = JSON.parse(event.data);

        if (message.type === 'request_offer') {
            console.log('[Camera] Host requested a new WebRTC Offer. Re-initiating...');

            const currentStream = document.getElementById('camera-feed').srcObject;
            if (currentStream) {
                await createWebRTCPeer(currentStream);
            }
        }
        else if (message.type === 'answer' && cameraPc) {
            console.log('[Camera] Received WebRTC Answer from host.');
            await cameraPc.setRemoteDescription(new RTCSessionDescription(message));
        }
        else if (message.type === 'ice' && cameraPc) {
            // FIX: Prevent InvalidStateError if ICE arrives before Answer
            if (!cameraPc.remoteDescription) return;
            await cameraPc.addIceCandidate(new RTCIceCandidate(message.candidate));
        }
    };

    // Auto-reconnect on error/close
    cameraWs.onclose = () => {
        isConnecting = false;

        // FIX: Destroy old WebRTC connection to prevent state leaks and ICE conflicts during reconnection
        if (cameraPc) {
            cameraPc.close();
            cameraPc = null;
        }

        // FIX: If in background, do not loop reconnect, wait for visibilitychange
        if (document.hidden) {
            console.log('[Camera] Disconnected while page is hidden. Will reconnect on focus.');
            return;
        }

        if (retryCount >= MAX_RETRIES) {
            console.warn(`[Camera] Signaling disconnected. Max retries (${MAX_RETRIES}) reached. Please refresh the page.`);
            return;
        }

        retryCount++;
        const delay = Math.min(3000 * Math.pow(2, retryCount - 1), 30000);
        console.log(`[Camera] Signaling disconnected. Reconnecting in ${delay / 1000}s... (Attempt ${retryCount}/${MAX_RETRIES})`);
        setTimeout(startCameraStream, delay);
    };

    cameraWs.onerror = () => {
        if (cameraWs) cameraWs.close();
    };
}

async function createWebRTCPeer(stream) {
    if (cameraPc) cameraPc.close();

    cameraPc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    stream.getTracks().forEach(track => cameraPc.addTrack(track, stream));

    cameraPc.onicecandidate = (event) => {
        if (event.candidate && cameraWs && cameraWs.readyState === WebSocket.OPEN) {
            cameraWs.send(JSON.stringify({ type: 'ice', candidate: event.candidate }));
        }
    };

    const offer = await cameraPc.createOffer();
    await cameraPc.setLocalDescription(offer);
    cameraWs.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
}

window.addEventListener('load', () => setTimeout(startCameraStream, 1500));

// FIX: Force reconnect when user switches back to the tab
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!cameraWs || cameraWs.readyState !== WebSocket.OPEN) {
            console.log('[Camera] Page returned to foreground. Resetting retries and reconnecting...');
            retryCount = 0;
            startCameraStream();
        }
    }
});