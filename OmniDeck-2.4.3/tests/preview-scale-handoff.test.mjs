// Behavioural unit test for the authoritative Preview -> Presentation scale handoff.
// This exercises renderScaledPresentSlide directly with the project DOM test double;
// it is not a full browser/WebView visual test.
import { installMiniDom, findNode, hasClass } from "./helpers/miniDom.mjs";
import { makeChecker } from "./helpers/fakeDisk.mjs";

installMiniDom();
const { check, done } = makeChecker();
const { renderScaledPresentSlide } = await import("../src/js/components/slideStage.js");

const page = {
  id: "scripture-scale",
  type: "scripture",
  reference: "Exodus 11:1-2",
  verses: [
    { number: 1, text: "A long passage, used to check that the preview's fitted text scale is handed to presentation." },
    { number: 2, text: "A second verse confirms that the same surface also carries scale to reference and following content." },
  ],
};
const output = renderScaledPresentSlide(page, { interactive: false }, {
  width: 716,
  height: 402,
  slideWidth: 714,
  presentScale: 0.56,
});
const design = findNode(output, (n) => hasClass(n, "present-slide__design"));
check("presentation design surface exists", !!design);
check("presentation keeps preview logical width", design?.style.width === "716px");
check("presentation keeps preview logical height", design?.style.height === "402px");
check("presentation uses the preview slide width for relative typography", design?.style.getPropertyValue("--slide-w") === "714px");
check("presentation preserves the preview's exact auto-fit factor", design?.style.getPropertyValue("--present-scale") === "0.56");

const legacy = renderScaledPresentSlide(page, { interactive: false }, { width: 716, height: 402, slideWidth: 714 });
const legacyDesign = findNode(legacy, (n) => hasClass(n, "present-slide__design"));
check("direct/legacy presentation without a captured factor remains backward-compatible", legacyDesign?.style.getPropertyValue("--present-scale") === "");

done();
