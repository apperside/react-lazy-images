import React from "react";
import Observer from "react-intersection-observer";
import { unionize, ofType, UnionOf } from "unionize";

/**
 * Valid props for LazyImage components
 */
export type CommonLazyImageProps = ImageProps & {
  /** Whether to skip checking for viewport and always show the 'actual' component
   * @see https://github.com/fpapado/react-lazy-images/#eager-loading--server-side-rendering-ssr
   */
  loadEagerly?: boolean;

  /** Subset of props for the IntersectionObserver
   * @see https://github.com/thebuilder/react-intersection-observer#props
   */
  observerProps?: ObserverProps;

  /** Use the Image Decode API;
   * The call to a new HTML <img> element’s decode() function returns a promise, which,
   * when fulfilled, ensures that the image can be appended to the DOM without causing
   * a decoding delay on the next frame.
   *  @see: https://www.chromestatus.com/feature/5637156160667648
   */
  experimentalDecode?: boolean;
};

/** Valid props for LazyImageFull */
export interface LazyImageFullProps extends CommonLazyImageProps {
  /** Children should be either a function or a node */
  children: (args: RenderCallbackArgs) => React.ReactNode;
}

/** Values that the render props take */
export interface RenderCallbackArgs {
  imageState: ImageState;
  imageProps: ImageProps;
  /** When not loading eagerly, a ref to bind to the DOM element. This is needed for the intersection calculation to work. */
  ref?: React.RefObject<any>;
}

export interface ImageProps {
  /** The source of the image to load */
  src: string;

  /** The source set of the image to load */
  srcSet?: string;

  /** The alt text description of the image you are loading */
  alt?: string;

  /** Sizes descriptor */
  sizes?: string;
}

/** Subset of react-intersection-observer's props */
export interface ObserverProps {
  /**
   * Margin around the root that expands the area for intersection.
   * @see https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver/rootMargin
   * @default "50px 0px"
   * @example Declaration same as CSS margin:
   *  `"10px 20px 30px 40px"` (top, right, bottom, left).
   */
  rootMargin?: string;

  /** Number between 0 and 1 indicating the the percentage that should be
   * visible before triggering.
   * @default `0.01`
   */
  threshold?: number;
}

/** States that the image loading can be in.
 * Used together with LazyImageFull render props
 * External representation of the internal state
 * */
export enum ImageState {
  NotAsked = "NotAsked",
  Buffering = "Buffering",
  Loading = "Loading",
  LoadSuccess = "LoadSuccess",
  LoadError = "LoadError"
}

/** The component's state */
const LazyImageFullState = unionize({
  NotAsked: {},
  Buffering: ofType<CancelablePromise>(),
  // Could try to make it Promise<HTMLImageElement>, but we don't use the element anyway
  Loading: ofType<Promise<void>>(),
  LoadSuccess: {},
  // LoadSuccessPreload: ofType<HTMLImageElement>(),
  // LoadSuccessNoPreload: {},
  LoadError: ofType<{ msg: string }>()
});

type LazyImageFullState = UnionOf<typeof LazyImageFullState>;

const Action = unionize({
  ViewChanged: ofType<{ inView: boolean }>(),
  BufferingSuccess: {},
  // MAYBE? Load: {},
  LoadSuccess: {},
  LoadError: ofType<{ msg: string }>()
});

type Action = UnionOf<typeof Action>;

/**
 * Component that preloads the image once it is in the viewport,
 * and then swaps it in. Takes a render prop that allows to specify
 * what is rendered based on the loading state.
 */
export class LazyImageFull extends React.Component<
  LazyImageFullProps,
  LazyImageFullState
> {
  static displayName = "LazyImageFull";

  initialState = LazyImageFullState.NotAsked();

  constructor(props: LazyImageFullProps) {
    super(props);
    this.state = this.initialState;

    // Bind methods
    // This would be nicer with arrow functions and class properties,
    // but holding off until they are settled.
    this.update = this.update.bind(this);
    this.reducer = this.reducer.bind(this);
  }

  update(action: Action) {
    this.setState((prevState: LazyImageFullState, props) =>
      this.reducer(action, prevState, props)
    );
  }

  // Emit the next state based on actions
  reducer(
    action: Action,
    prevState: LazyImageFullState,
    props: LazyImageFullProps
  ) {
    return Action.match(action, {
      ViewChanged: ({ inView }) => {
        if (inView === true) {
          // If src is not specified, then there is nothing to preload; skip to Loaded state
          if (!props.src) {
            return LazyImageFullState.LoadSuccess(); // Error wtf
          } else {
            // If in view, start Buffering if NotAsked, otherwise leave untouched
            LazyImageFullState.match(prevState, {
              NotAsked: () => {
                // Make cancelable buffering Promise
                const bufferingPromise = makeCancelable(delayedPromise(1000));

                // Kick off promise chain
                bufferingPromise.promise
                  .then(() => this.update(Action.BufferingSuccess()))
                  .catch(reason =>
                    console.log("isCancelled", reason.isCancelled)
                  ); // TODO: think more about this

                return LazyImageFullState.Buffering(bufferingPromise);
              },
              default: () => prevState
            });
          }
        } else {
          // If out of view, cancel the Buffering, otherwise leave untouched
          LazyImageFullState.match(prevState, {
            Buffering: bufferingPromise => {
              bufferingPromise.cancel();
              return LazyImageFullState.NotAsked();
            },
            default: () => prevState
          });
        }
      },
      BufferingSuccess: () => {
        const { src, srcSet, alt, sizes, experimentalDecode } = props;
        // Buffering has ended/succeeded, kick off request for image
        // Kick off request for Image and attach listeners for response
        const loadingPromise = loadImage(
          {
            src,
            srcSet,
            alt,
            sizes
          },
          experimentalDecode
        )
          .then(_res => this.update(Action.LoadSuccess({})))
          .catch(_e =>
            this.update(Action.LoadError({ msg: "Failed to load" }))
          ); // TODO: think more about this

        return LazyImageFullState.Loading(loadingPromise);
      },
      LoadSuccess: () => LazyImageFullState.LoadSuccess(),
      LoadError: e => LazyImageFullState.LoadError(e)
    });
  }

  // Render function
  render() {
    const {
      children,
      loadEagerly,
      observerProps,
      experimentalDecode,
      ...imageProps
    } = this.props;

    if (loadEagerly) {
      // If eager, skip the observer and view changing stuff; resolve the imageState as loaded.
      return children({
        imageState: LazyImageFullState.LoadSuccess().tag as ImageState,
        imageProps
      });
    } else {
      return (
        <Observer
          rootMargin="50px 0px"
          // TODO: reconsider threshold
          threshold={0.01}
          {...observerProps}
          onChange={inView => this.update(Action.ViewChanged({ inView }))}
        >
          {({ ref }) =>
            children({
              imageState: this.state.tag as ImageState,
              imageProps,
              ref
            })
          }
        </Observer>
      );
    }
  }
}

// Utilities

/** Promise constructor for loading an image */
const loadImage = (
  { src, srcSet, alt, sizes }: ImageProps,
  experimentalDecode = false
) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    if (srcSet) {
      image.srcset = srcSet;
    }
    if (alt) {
      image.alt = alt;
    }
    if (sizes) {
      image.sizes = sizes;
    }
    image.src = src;

    /** @see: https://www.chromestatus.com/feature/5637156160667648 */
    // if (experimentalDecode && "decode" in image) {
    //   return image
    //     // NOTE: .decode() is not in the TS defs yet
    //     //@ts-ignore
    //     .decode()
    //     .then((image: HTMLImageElement) => resolve(image))
    //     .catch((err: any) => reject(err));
    // }

    image.onload = resolve;
    image.onerror = reject;
  });

/** Promise that resolves after a specified number of ms */
const delayedPromise = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

interface CancelablePromise {
  promise: Promise<{}>;
  cancel: () => void;
}

const makeCancelable = (promise: Promise<any>): CancelablePromise => {
  let hasCanceled_ = false;

  const wrappedPromise = new Promise((resolve, reject) => {
    promise.then(
      (val: any) => (hasCanceled_ ? reject({ isCanceled: true }) : resolve(val))
    );
    promise.catch(
      (error: any) =>
        hasCanceled_ ? reject({ isCanceled: true }) : reject(error)
    );
  });

  return {
    promise: wrappedPromise,
    cancel() {
      hasCanceled_ = true;
    }
  };
};