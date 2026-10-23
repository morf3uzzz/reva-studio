import assert from "node:assert/strict";
import test from "node:test";
import {
  getCameraAutoAspectRatio,
  getSplitRestingScreenSide,
  resolveCameraGeometry,
  type CameraConfig,
  type CameraGeometryInput,
  type CameraGeometryResult,
  type CameraRect,
} from "../src/core/camera.ts";

const overlay: Extract<CameraConfig, { type: "camera-overlay" }> = {
  type: "camera-overlay",
  position: { x: 1, y: 1 },
  sizeRatio: 0.5,
  paddingRatio: 0.5,
  aspectRatio: 1,
  zoomScale: 0.8,
};
const cutout: Extract<CameraConfig, { type: "cutout-camera" }> = {
  type: "cutout-camera",
  positionX: 1,
  sizeRatio: 0.5,
  aspectRatio: null,
  zoomScale: 0.8,
};
const split: Extract<CameraConfig, { type: "split-screen" }> = {
  type: "split-screen",
  direction: "auto",
  flip: false,
  screenRatio: null,
  enablePadding: false,
};
const input: CameraGeometryInput = {
  stage: { width: 1920, height: 1080 },
  screenSource: { width: 1920, height: 1080 },
  paddingRatio: 0.1,
};
const value = <T>(result: CameraGeometryResult<T>): T => {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
};
const close = (actual: number, expected: number, tolerance = 1e-8) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );
const rect = (actual: CameraRect, expected: CameraRect, tolerance = 1e-8) => {
  for (const key of ["x", "y", "width", "height"] as const)
    close(actual[key], expected[key], tolerance);
};

test("Overlay and Cutout agree with independently measured original-app screenshots", () => {
  // Independently recorded camera-layout geometry cases.
  // Physical stage origin (434,234), size (1424,984); +/-3px manual edges.
  const observed = {
    ...input,
    stage: { width: 1424, height: 984 },
    cameraSourceAspectRatio: 16 / 9,
  };
  const over = value(
    resolveCameraGeometry({ ...overlay, sizeRatio: 0.3025 }, observed),
  );
  rect(over.resting.camera, { x: 1071, y: 631, width: 299, height: 299 }, 3);
  const cut = value(
    resolveCameraGeometry(
      { ...cutout, sizeRatio: 0.5454, zoomScale: 0.843 },
      observed,
    ),
  );
  rect(cut.resting.camera, { x: 806, y: 683, width: 534, height: 300 }, 3);
  assert.equal(cut.requiresForegroundAlpha, true);
  assert.equal(cut.resting.allowsCameraBorderRadius, false);
  assert.equal(cut.zoomed.allowsCameraBorderRadius, false);
  assert.equal(over.requiresForegroundAlpha, false);
});

test("Overlay uses the longest dimension and halves padding only for its zoom endpoint", () => {
  const geometry = value(resolveCameraGeometry(overlay, input));
  rect(geometry.resting.camera, { x: 1320, y: 480, width: 540, height: 540 });
  rect(geometry.zoomed.camera, {
    x: 1456.235294117647,
    y: 616.2352941176471,
    width: 432,
    height: 432,
  });
  rect(geometry.resting.zoomArea, { x: 90, y: 90, width: 1740, height: 900 });
  rect(geometry.resting.screen, { x: 160, y: 90, width: 1600, height: 900 });
  assert.deepEqual(geometry.zoomed.screen, geometry.resting.screen);
  const portrait = value(
    resolveCameraGeometry(
      { ...overlay, aspectRatio: 9 / 16, position: { x: 0.25, y: 0.75 } },
      input,
    ),
  );
  rect(portrait.resting.camera, {
    x: 434.0625,
    y: 375,
    width: 303.75,
    height: 540,
  });
});

test("Cutout is bottom-flush, retains horizontal padding during zoom and resolves camera aspect explicitly", () => {
  const geometry = value(
    resolveCameraGeometry(cutout, {
      ...input,
      cameraSourceAspectRatio: 16 / 9,
    }),
  );
  rect(geometry.resting.camera, {
    x: 1290,
    y: 776.25,
    width: 540,
    height: 303.75,
  });
  rect(geometry.zoomed.camera, { x: 1398, y: 837, width: 432, height: 243 });
  const explicit = value(
    resolveCameraGeometry(
      { ...cutout, positionX: 0.5, aspectRatio: 3 / 4 },
      { ...input, cameraSourceAspectRatio: 16 / 9 },
    ),
  );
  rect(explicit.resting.camera, { x: 757.5, y: 540, width: 405, height: 540 });
  const unknownSource = value(resolveCameraGeometry(cutout, input));
  assert.equal(
    unknownSource.resting.camera.width,
    unknownSource.resting.camera.height,
  );
});

test("screen cover and contain are distinct without changing camera placement", () => {
  const contain = value(resolveCameraGeometry(overlay, input));
  const cover = value(
    resolveCameraGeometry(overlay, { ...input, avoidEmptyZoomArea: true }),
  );
  rect(cover.resting.screen, { x: 90, y: 50.625, width: 1740, height: 978.75 });
  assert.deepEqual(cover.resting.camera, contain.resting.camera);
});

test("Auto canvas aspect matches independent source-derived numeric vectors", () => {
  close(
    value(getCameraAutoAspectRatio(overlay, input.screenSource, 0.1)),
    89 / 54,
  );
  close(
    value(getCameraAutoAspectRatio(cutout, input.screenSource, 0.1)),
    89 / 54,
  );
  close(
    value(getCameraAutoAspectRatio(split, { width: 4, height: 3 }, 0.1)),
    16 / 9,
  );
  close(
    value(getCameraAutoAspectRatio(split, input.screenSource, 0.1)),
    337 / 144,
  );
  close(
    value(
      getCameraAutoAspectRatio(
        { ...split, enablePadding: true },
        { width: 8, height: 5 },
        0.1,
      ),
    ),
    197 / 96,
  );
  close(
    value(getCameraAutoAspectRatio(split, { width: 4, height: 1 }, 0)),
    2.4,
  );
  close(
    value(getCameraAutoAspectRatio(split, { width: 1, height: 4 }, 0)),
    16 / 9,
  );
});

test("Split half screen covers its area and zooms into a separate Overlay layout", () => {
  const geometry = value(
    resolveCameraGeometry({ ...split, screenRatio: 0.5 }, input),
  );
  assert.equal(geometry.screenSide, "left");
  rect(geometry.resting.camera, { x: 960, y: 0, width: 960, height: 1080 });
  rect(geometry.resting.zoomArea, { x: 0, y: 0, width: 960, height: 1080 });
  rect(geometry.resting.screen, { x: -480, y: 0, width: 1920, height: 1080 });
  // 960/1080 is retained; the reference clamp is [9/16,16/9], not [.9,16/9].
  rect(geometry.zoomed.camera, { x: 1380, y: 480, width: 480, height: 540 });
  rect(geometry.zoomed.screen, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(geometry.resting.allowsCameraBorderRadius, false);
  assert.equal(geometry.zoomed.allowsCameraBorderRadius, true);
});

test("Auto Split preserves source height when space permits and uses half split vertically", () => {
  const horizontal = value(
    resolveCameraGeometry(split, {
      ...input,
      stage: { width: 2400, height: 1080 },
    }),
  );
  rect(horizontal.resting.screen, { x: 0, y: 0, width: 1920, height: 1080 });
  rect(horizontal.resting.camera, { x: 1920, y: 0, width: 480, height: 1080 });
  rect(horizontal.zoomed.camera, {
    x: 2036.25,
    y: 480,
    width: 303.75,
    height: 540,
  });
  const portraitInput = { ...input, stage: { width: 1080, height: 1920 } };
  const auto = value(resolveCameraGeometry(split, portraitInput));
  const half = value(
    resolveCameraGeometry({ ...split, screenRatio: 0.5 }, portraitInput),
  );
  assert.deepEqual(auto, half);
  assert.equal(auto.screenSide, "top");
});

test("padded vertical Split shortens overflowing screen width by ten percent", () => {
  const geometry = value(
    resolveCameraGeometry(
      { ...split, enablePadding: true, screenRatio: 2 / 3 },
      {
        ...input,
        stage: { width: 720, height: 1280 },
        screenSource: { width: 9, height: 16 },
      },
    ),
  );
  rect(geometry.resting.camera, {
    x: 60,
    y: 853.3333333333333,
    width: 600,
    height: 366.6666666666667,
  });
  rect(geometry.resting.zoomArea, {
    x: 60,
    y: 60,
    width: 600,
    height: 733.3333333333333,
  });
  rect(geometry.resting.screen, {
    x: 90,
    y: -53.33333333333337,
    width: 540,
    height: 960,
  });
  assert.equal(geometry.resting.allowsScreenBorderRadius, true);
});

test("Split camera fallback dimensions are deliberate and impossible directions fail explicitly", () => {
  const horizontal = value(
    resolveCameraGeometry({ ...split, screenRatio: 0.9 }, input),
  );
  rect(horizontal.resting.camera, { x: 1380, y: 0, width: 540, height: 1080 });
  const vertical = value(
    resolveCameraGeometry(
      { ...split, screenRatio: 0.9 },
      { ...input, stage: { width: 1080, height: 1920 } },
    ),
  );
  rect(vertical.resting.camera, { x: 0, y: 1488, width: 1080, height: 432 });
  const impossible = resolveCameraGeometry(
    { ...split, direction: "horizontal" },
    { ...input, stage: { width: 100, height: 1000 } },
  );
  assert.equal(impossible.ok, false);
  if (!impossible.ok)
    assert.equal(impossible.error.code, "camera_layout_unavailable");
});

test("Flip reflects both split regions and puts the zoom overlay on the corresponding camera edge", () => {
  for (const stage of [
    { width: 1920, height: 1080 },
    { width: 1080, height: 1920 },
  ]) {
    const first = value(
      resolveCameraGeometry(
        { ...split, screenRatio: 0.5 },
        { ...input, stage },
      ),
    );
    const flipped = value(
      resolveCameraGeometry(
        { ...split, screenRatio: 0.5, flip: true },
        { ...input, stage },
      ),
    );
    for (const part of ["screen", "camera", "zoomArea"] as const) {
      const original = first.resting[part];
      rect(
        flipped.resting[part],
        stage.width > stage.height
          ? { ...original, x: stage.width - original.x - original.width }
          : { ...original, y: stage.height - original.y - original.height },
      );
    }
    if (stage.width > stage.height) close(flipped.zoomed.camera.x, 60);
    else close(flipped.zoomed.camera.y, 60);
  }
});

test("layout endpoints are resolution independent, including the half-canonical-pixel overflow threshold", () => {
  const config: CameraConfig = {
    ...split,
    screenRatio: 0.5,
    enablePadding: true,
  };
  // At 1080 height, split area is 825x900; 0.3px horizontal overflow stays below 0.5px.
  const source = { width: 825.3, height: 900 };
  const reference = value(
    resolveCameraGeometry(config, { ...input, screenSource: source }),
  );
  close(reference.resting.screen.height, 900);
  for (const scale of [0.25, 0.5, 2, 4]) {
    const scaled = value(
      resolveCameraGeometry(config, {
        ...input,
        screenSource: source,
        stage: { width: 1920 * scale, height: 1080 * scale },
      }),
    );
    for (const endpoint of ["resting", "zoomed"] as const) {
      for (const part of ["screen", "camera", "zoomArea"] as const) {
        const original = reference[endpoint][part];
        rect(scaled[endpoint][part], {
          x: original.x * scale,
          y: original.y * scale,
          width: original.width * scale,
          height: original.height * scale,
        });
      }
    }
  }
});

test("resting Split changes the screen anchor before the cursor enters camera clearance", () => {
  const geometry = value(
    resolveCameraGeometry({ ...split, screenRatio: 0.5 }, input),
  );
  assert.equal(
    value(
      getSplitRestingScreenSide(geometry, {
        x: 0.3,
        y: 0.5,
        width: 0,
        height: 0,
      }),
    ),
    "left",
  );
  // Camera starts at x=960 and screen width=1920: threshold is x=720 (37.5%).
  assert.equal(
    value(
      getSplitRestingScreenSide(geometry, {
        x: 0.375,
        y: 0.5,
        width: 0,
        height: 0,
      }),
    ),
    "left",
  );
  assert.equal(
    value(
      getSplitRestingScreenSide(geometry, {
        x: 0.38,
        y: 0.5,
        width: 0,
        height: 0,
      }),
    ),
    "right",
  );
  assert.equal(
    value(
      getSplitRestingScreenSide(geometry, {
        x: 0.3,
        y: 0.5,
        width: 0.1,
        height: 0,
      }),
    ),
    "right",
  );
  assert.equal(
    getSplitRestingScreenSide(geometry, { x: 0.9, y: 0, width: 0.2, height: 0 })
      .ok,
    false,
  );
});

test("invalid numeric boundaries are tagged errors and inputs remain unchanged", () => {
  for (const invalid of [NaN, Infinity, -1, 0]) {
    assert.equal(
      resolveCameraGeometry({ ...overlay, sizeRatio: invalid }, input).ok,
      false,
    );
    assert.equal(
      resolveCameraGeometry(overlay, {
        ...input,
        stage: { width: invalid, height: 1080 },
      }).ok,
      false,
    );
    assert.equal(
      getCameraAutoAspectRatio(overlay, { width: invalid, height: 1080 }, 0.1)
        .ok,
      false,
    );
  }
  assert.equal(
    resolveCameraGeometry({ ...overlay, position: { x: 2, y: 0 } }, input).ok,
    false,
  );
  assert.equal(
    resolveCameraGeometry({ ...split, screenRatio: 1 }, input).ok,
    false,
  );
  assert.equal(
    resolveCameraGeometry(cutout, { ...input, cameraSourceAspectRatio: 0 }).ok,
    false,
  );
  assert.equal(
    resolveCameraGeometry(overlay, { ...input, paddingRatio: -0.1 }).ok,
    false,
  );
  const saved = JSON.stringify([overlay, split, cutout, input]);
  for (const config of [overlay, split, cutout]) {
    value(resolveCameraGeometry(config, input));
    value(
      getCameraAutoAspectRatio(config, input.screenSource, input.paddingRatio),
    );
  }
  assert.equal(JSON.stringify([overlay, split, cutout, input]), saved);
});
