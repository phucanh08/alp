import * as React from 'react';
import { MAIN_PANE } from '../lib/panes.js';

/** The pane around a part of the center (lib/panes.js): its id and whether it has focus. */
export const PaneContext = React.createContext<{ id: string; focused: boolean }>({ id: MAIN_PANE, focused: true });

/** Whether this part of the center is in the focused pane (true outside the panes). */
export const usePaneFocused = () => React.useContext(PaneContext).focused;
