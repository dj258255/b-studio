package com.example.api;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class PingController {

    @GetMapping("/api/ping")
    Map<String, String> ping() {
        return Map.of("message", "pong");
    }
}
