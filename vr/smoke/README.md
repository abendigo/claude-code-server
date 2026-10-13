# Startup check for the VR page without a browser

`./run.sh` runs the real `client/js/main.js` in Node with stubbed browser APIs (a fake WebGL renderer,
a fake websocket, a stub 2D canvas), drives it (mouse drag, keyboard, a fake session service) and prints
PASS/FAIL lines. It catches crashes at startup and wiring mistakes between modules that the unit tests
cannot, but it is not a real browser: nothing here proves how it looks or feels in the headset.

    cd vr && ./smoke/run.sh
