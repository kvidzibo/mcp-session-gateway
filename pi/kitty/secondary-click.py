"""Kitty-only alternate/double action for a gateway footer hyperlink."""
from pathlib import Path
import re

from kittens.tui.handler import result_handler
from kitty.fast_data_types import MOUSE_SELECTION_WORD


def main(args):
    pass


@result_handler(no_ui=True)
def handle_result(args, result, target_window_id, boss):
    window = boss.window_id_map.get(target_window_id)
    if window is None:
        return
    position = window.current_mouse_position()
    if position is None:
        return
    url = window.screen.hyperlink_at(position["cell_x"], position["cell_y"])
    double = len(args) > 1 and args[1] == "--double"
    if not isinstance(url, str) or not re.fullmatch(r"pi-gateway-action://[1-9][0-9]*-[0-9a-f]{8}/[0-9a-f]{32}", url):
        if double:
            window.mouse_selection(MOUSE_SELECTION_WORD)
        return
    helper = str(Path(args[0]).resolve().parents[1] / "footer-click.cjs")
    boss.run_background_process(["node", helper, "--double" if double else "--secondary", url])
