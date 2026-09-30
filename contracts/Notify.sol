// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Notify {
    event Notification(bytes32 indexed data);

    function notify(bytes32 data) external {
        emit Notification(data);
    }
}
