import { pushOne } from "com/store/IDBQueue";

//
const boardcastChannel = new BroadcastChannel('geolocation');

//
export const startTrackingRemote = () => {
    boardcastChannel.postMessage({ type: 'start' });
}

//
export const stopTrackingRemote = () => {
    boardcastChannel.postMessage({ type: 'stop' });
}

//
boardcastChannel.onmessage = (e) => {
    pushOne({ type: 'geolocation', value: e.data.value });
}
