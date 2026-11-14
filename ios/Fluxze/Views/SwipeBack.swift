import UIKit

/// Keeps swipe-from-the-left-edge-to-go-back working on screens that hide the
/// system navigation bar (the email screen draws its own slim bar). UIKit
/// turns the gesture off with the bar; this re-enables it whenever there is a
/// screen to go back to.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}
